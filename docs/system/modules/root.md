# root
**Source**: `src/`
**Summary**: Root-level runtime contracts, environment configuration, logging factories, and log retention helpers shared across Meridian subsystems.
**Last Scanned**: `2026-05-05T00:00:00+09:00` `[UPDATED 2026-05-05]`
**Exports Documented**: 86

`src/types.ts` is Meridian's central contract layer: it defines the Zod validators and inferred TypeScript shapes used by the hub, interface, shared transports, CLI, and monitor code. `src/config.ts`, `src/logger.ts`, and `src/log-retention.ts` provide the process-wide defaults and operational utilities those modules rely on.

## Zod Schema Inventory

`src/types.ts` exports 36 schema values. Object schemas list field names, optional markers, and defaulted fields; scalar schemas list allowed literals or constraints.

| Schema | Kind | Fields / Allowed Values | Purpose | Key refs |
|--------|------|-------------------------|---------|----------|
| `ChannelSchema` | `enum` | `telegram`, `web`, `socket` | Validates inbound and reply channel identifiers. | `src/types.ts:3` |
| `BuiltInIntentSchema` | `enum` | `run`, `terminal_input`, `spawn`, `restart`, `reboot`, `kill`, `status`, `attach`, `detach`, `gui`, `list`, `list_models`, `switch_model`, `detail`, `monitor_update`, `monitor_manual_update`, `push`, `capture_interval`, `history`, `set_auto_approve`, `register_service`, `unregister_service`, `reply`, `register_caller`, `unregister_caller`, `rotate_caller_key`, `list_callers` | Validates Meridian's reserved hub intents. | `src/types.ts:37` `[UPDATED 2026-05-05]` |
| `IntentSchema` | `union` | Built-in intent enum or any non-empty string | Keeps the core intent set strict while allowing service-defined custom intents. | `src/types.ts:38` `[UPDATED 2026-05-05]` |
| `BridgeModeSchema` | `enum` | `bridge`, `pane_bridge`, `stateless_call` | Distinguishes ordinary bridge execution from pane-streaming mode. | `src/types.ts:41` `[UPDATED 2026-05-05]` |
| `AgentTypeSchema` | `enum` | `claude`, `codex`, `gemini`, `cursor` | Validates the supported provider identifiers. | `src/types.ts:44` `[UPDATED 2026-05-05]` |
| `ReasoningEffortSchema` | `enum` | `low`, `medium`, `high`, `xhigh` | Constrains provider reasoning effort selections. | `src/types.ts:53` `[UPDATED 2026-05-05]` |
| `HubResultStatusSchema` | `enum` | `success`, `error`, `partial`, `timeout` | Normalizes the top-level status on hub replies. | `src/types.ts:56` `[UPDATED 2026-05-05]` |
| `HubRunStateSchema` | `enum` | `completed`, `still_running`, `timeout` | Describes whether a run is finished or still active. | `src/types.ts:59` `[UPDATED 2026-05-05]` |
| `AgentInstanceStatusSchema` | `enum` | `idle`, `running`, `waiting`, `stopped`, `error` | Defines lifecycle states persisted for live agent instances. | `src/types.ts:62` `[UPDATED 2026-05-05]` |
| `ThreadProgressEventKindSchema` | `enum` | `progress`, `approval` | Distinguishes ordinary progress text from approval prompts. | `src/types.ts:65` `[UPDATED 2026-05-05]` |
| `ThreadProgressPhaseSchema` | `enum` | `running`, `waiting_for_input` | Marks the current phase of a partial-progress update. | `src/types.ts:68` `[UPDATED 2026-05-05]` |
| `ThreadProgressSnapshotSchema` | `object` | `trace_id`, `thread_id`, `source`, `status="partial"`, `event_kind`, `phase`, `waiting_for_input`, `content`, `display_text`, `updated_at` | Validates structured progress snapshots embedded in partial results. | `src/types.ts:71` `[UPDATED 2026-05-05]` |
| `FileAttachmentSchema` | `object` | `path`, `filename?`, `mime_type?` | Describes file attachments forwarded with messages or results. | `src/types.ts:85` `[UPDATED 2026-05-05]` |
| `TelegramInlineButtonSchema` | `object` | `text`, `url?`, `callback_data?`; refine requires exactly one of `url` or `callback_data` | Validates Telegram inline button payloads. | `src/types.ts:114` `[UPDATED 2026-05-05]` |
| `TelegramInlineKeyboardSchema` | `object` | `inline_keyboard: TelegramInlineButton[][]` with non-empty rows | Wraps Telegram button grids for reply payloads. | `src/types.ts:125` `[UPDATED 2026-05-05]` |
| `InboundUIEventSchema` | `object` | `channel`, `raw_message_id`, `sender_id`, `content`, `attachments=[]`, `timestamp`, `reply_to` | Defines the canonical inbound interface event shape. | `src/types.ts:130` `[UPDATED 2026-05-05]` |
| `CompositeChatIdSchema` | `string` | `{channel}:{id}` regex | Validates the newer channel-prefixed chat identifier format. | `src/types.ts:141` `[UPDATED 2026-05-05]` |
| `LegacyChatIdSchema` | `string` | Non-empty string without `:` | Preserves backward compatibility for older chat IDs. | `src/types.ts:142` `[UPDATED 2026-05-05]` |
| `SessionChatIdSchema` | `union` | Composite or legacy chat ID | Accepts either supported chat identifier format. | `src/types.ts:143` `[UPDATED 2026-05-05]` |
| `ReplyChannelSchema` | `object` | `channel`, `chat_id`, `message_id?`, `bot_id?`, `chat_name?`, `bot_name?`, `socket_path?` | Captures routing metadata for Telegram, web, and socket replies. | `src/types.ts:146` `[UPDATED 2026-05-05]` |
| `CallerIdentitySchema` | `object` | `caller_id` (regex `^[a-z][a-z0-9_-]*$`), `caller_label?`, `caller_version?` | Validates the caller identity token attached to hub messages and agent instances. | `src/types.ts:158` `[ADDED 2026-05-05]` |
| `HubPayloadSchema` | `object` | `content`, `attachments=[]`, `raw_message_id?`, `reply_to?`, `spawn_dir?`, `model_id?`, `effort?`, `auto_approve?`, `monitor_updates_enabled?`, `monitor_updates_interval_sec?`, `gui_host_port_override?`, `push_enabled?` | Validates the payload body sent with hub intents. | `src/types.ts:165` `[UPDATED 2026-05-05]` |
| `PrioritySchema` | `number` | Integer `0` through `9` | Normalizes message priority for the hub queue. | `src/types.ts:187` `[UPDATED 2026-05-05]` |
| `OptionalUuidSchema` | `string` | Optional UUID | Reuses one tracing/span field helper across multiple objects. | `src/types.ts:190` `[UPDATED 2026-05-05]` |
| `HubMessageSchema` | `object` | `trace_id`, `thread_id`, `actor_id`, `idempotency_key?`, `priority=5`, `span_id?`, `parent_span_id?`, `intent`, `target`, `payload`, `mode`, `reply_channel`, `suppress_reply?`, `caller?` | Validates inbound hub requests and applies the default priority. | `src/types.ts:192` `[UPDATED 2026-05-05]` |
| `HubResultSchema` | `object` | `trace_id`, `thread_id`, `source`, `status`, `run_state?`, `content`, `summary_text?`, `details_text?`, `progress?`, `attachments=[]`, `telegram_inline_keyboard?`, `timestamp` | Validates the hub's final or partial result envelope. | `src/types.ts:210` `[UPDATED 2026-05-05]` |
| `MonitorEventTypeSchema` | `enum` | `task_completed`, `status_changed`, `heartbeat_missed`, `agent_error`, `sse_reconnect_failed` | Enumerates monitor event categories. | `src/types.ts:227` `[UPDATED 2026-05-05]` |
| `MonitorModeSchema` | `enum` | `sse_hook`, `heartbeat` | Identifies the transport mode used by monitoring. | `src/types.ts:236` `[UPDATED 2026-05-05]` |
| `MonitorEventSchema` | `object` | `trace_id=null`, `span_id?`, `parent_span_id?`, `thread_id`, `event_type`, `monitor_mode`, `timestamp`, `agent_status?`, `agent_type?`, `last_known_pid?`, `missed_heartbeats?`, `sse_reconnect_count?`, `details?`, `error?` | Structures monitor telemetry for status and failure reporting. | `src/types.ts:239` `[UPDATED 2026-05-05]` |
| `AgentInstanceSchema` | `object` | `thread_id`, `agent_type`, `model_id?`, `reasoning_effort?`, `supportsStream?`, `codexSessionId?`, `mode`, `socket_path`, `working_dir?`, `pid`, `tmux_pane`, `status`, `created_at`, `restart_safe?`, `auto_approve=true`, `spawn_trace_id?`, `spawned_by?`, `last_caller?`, `last_caller_at?` | Validates persisted and in-memory agent instance state. | `src/types.ts:257` `[UPDATED 2026-05-05]` |
| `PaneSubscribeRequestSchema` | `object` | `type="subscribe_pane_output"`, `thread_id`, `replay_lines?` | Validates pane output subscribe requests. | `src/types.ts:283` `[UPDATED 2026-05-05]` |
| `PaneOutputChunkSchema` | `object` | `type="pane_output"`, `thread_id`, `chunk`, `cursor?`, `timestamp?`, `span_id?`, `parent_span_id?` | Describes incremental pane output frames broadcast to listeners. | `src/types.ts:290` `[UPDATED 2026-05-05]` |
| `PaneOutputNotAvailableSchema` | `object` | `type="not_available"`, `thread_id`, `reason` | Reports why pane output cannot be streamed for a thread. | `src/types.ts:301` `[UPDATED 2026-05-05]` |
| `PaneUnsubscribeRequestSchema` | `object` | `type="unsubscribe_pane_output"`, `thread_id` | Validates pane output unsubscribe requests. | `src/types.ts:308` `[UPDATED 2026-05-05]` |
| `ProviderModelSchema` | `object` | `id`, `label` | Represents one selectable provider model. | `src/types.ts:314` `[UPDATED 2026-05-05]` |
| `ProviderModelCatalogSchema` | `object` | `thread_id`, `provider`, `current_model_id=null`, `models[]` | Wraps the available model list for one provider thread. | `src/types.ts:320` `[UPDATED 2026-05-05]` |
| `ServiceEndpointSchema` | `object` | `service?`, `socket_path`, `intents=[]`, `metadata?` | Validates dynamic service-registry endpoint records. | `src/types.ts:342` `[UPDATED 2026-05-05]` |

## Config Key Inventory

`src/config.ts` validates 43 environment-derived keys through a private `envSchema`, then exposes the parsed result via `parseConfig()` and the module-level `config` singleton. Conditional requirements are enforced for the web GUI host/token pair and TLS cert/key paths. Two additional environment variables are observed outside `envSchema` by the caller-registry round (see the table below): `MERIDIAN_INTERNAL_BOOTSTRAP_KEY` is auto-managed by the hub boot path, and `MERIDIAN_CALLER_KEYS` is the legacy state-store seed. [UPDATED 2026-05-05]

| Config Key | Env Var | Type / Parser | Default / Required | Notes |
|-----------|---------|---------------|--------------------|-------|
| `NODE_ENV` | `NODE_ENV` | `enum` | `development` | Accepts `development`, `test`, or `production`. |
| `LOG_LEVEL` | `LOG_LEVEL` | `enum` | `debug` | Accepts `trace`, `debug`, `info`, `warn`, `error`, or `fatal`. |
| `TELEGRAM_BOT_TOKEN` | `TELEGRAM_BOT_TOKEN` | `string` | Required | Primary Telegram bot token for the interface runtime. |
| `TELEGRAM_BOT_TOKENS` | `TELEGRAM_BOT_TOKENS` | `string` | Optional | Secondary/multi-bot token payload; left as a raw string here. |
| `ALLOWED_USER_IDS` | `ALLOWED_USER_IDS` | `csv -> number[]` | Required | Splits on commas and rejects empty, non-integer, or non-positive entries. |
| `HUB_SOCKET_PATH` | `HUB_SOCKET_PATH` | `string` | `/tmp/hub-core.sock` | Default Unix socket path for hub IPC. |
| `HEARTBEAT_INTERVAL_MS` | `HEARTBEAT_INTERVAL_MS` | `positive int` | `10000` | Heartbeat cadence in milliseconds. |
| `HEARTBEAT_MISSED_THRESHOLD` | `HEARTBEAT_MISSED_THRESHOLD` | `positive int` | `3` | Number of missed heartbeats before declaring failure. |
| `MONITOR_SYNC_INTERVAL_MS` | `MONITOR_SYNC_INTERVAL_MS` | `positive int` | `1000` | Poll/sync interval for monitor state refresh. |
| `MONITOR_PROGRESS_TICK_MS` | `MONITOR_PROGRESS_TICK_MS` | `positive int` | `1000` | Tick interval for progress updates. |
| `MONITOR_UPDATE_DEFAULT_INTERVAL_SEC` | `MONITOR_UPDATE_DEFAULT_INTERVAL_SEC` | `positive int` | `30` | Default proactive monitor update frequency. |
| `MONITOR_UPDATE_MIN_INTERVAL_SEC` | `MONITOR_UPDATE_MIN_INTERVAL_SEC` | `positive int` | `5` | Lower bound for requested monitor update intervals. |
| `MONITOR_UPDATE_MAX_INTERVAL_SEC` | `MONITOR_UPDATE_MAX_INTERVAL_SEC` | `positive int` | `600` | Upper bound for requested monitor update intervals. |
| `PANE_CAPTURE_INTERVAL_MS` | `PANE_CAPTURE_INTERVAL_MS` | `positive int` | `7000` | How often pane output is sampled. |
| `PANE_BROADCAST_THROTTLE_MS` | `PANE_BROADCAST_THROTTLE_MS` | `positive int` | `1000` | Minimum delay between pane broadcast pushes. |
| `LOG_DIR` | `LOG_DIR` | `string` | `/var/log/hub` | Root directory for hub, module, and session logs. |
| `LOG_RETENTION_ENABLED` | `LOG_RETENTION_ENABLED` | `boolean` | `true` | Parsed from `true` or `false`; master switch for the retention worker. |
| `LOG_RETENTION_INTERVAL_MS` | `LOG_RETENTION_INTERVAL_MS` | `positive int` | `300000` | Interval between retention passes. |
| `LOG_ACTIVE_FILE_MAX_BYTES` | `LOG_ACTIVE_FILE_MAX_BYTES` | `positive int` | `52428800` | Trim active logs after 50 MiB. |
| `LOG_ACTIVE_FILE_KEEP_BYTES` | `LOG_ACTIVE_FILE_KEEP_BYTES` | `positive int` | `5242880` | Keep the last 5 MiB of an oversized active log. |
| `LOG_SESSION_FILE_MAX_BYTES` | `LOG_SESSION_FILE_MAX_BYTES` | `positive int` | `10485760` | Trim session logs after 10 MiB. |
| `LOG_SESSION_FILE_KEEP_BYTES` | `LOG_SESSION_FILE_KEEP_BYTES` | `positive int` | `1048576` | Keep the last 1 MiB of an oversized session log. |
| `LOG_SESSION_FILE_MAX_AGE_HOURS` | `LOG_SESSION_FILE_MAX_AGE_HOURS` | `positive int` | `168` | Remove session logs older than 7 days. |
| `MERIDIAN_STATE_PATH` | `MERIDIAN_STATE_PATH` | `string` | `/tmp/meridian-state.json` | JSON state-store path. |
| `AGENT_WORKDIR` | `AGENT_WORKDIR` | `string` | `DEFAULT_AGENT_WORKDIR` | Default agent spawn root resolved from `process.cwd()/..`. |
| `COORDINATOR_SOCKET_PATH` | `COORDINATOR_SOCKET_PATH` | `string` | `""` | Empty string disables coordinator socket wiring. |
| `COORDINATOR_INTENTS` | `COORDINATOR_INTENTS` | `csv -> string[]` | `[]` | Splits, trims, and filters comma-separated intent names. |
| `WEBHOOK_URL` | `WEBHOOK_URL` | `string` | `""` | Public Telegram webhook URL base. |
| `WEBHOOK_PORT` | `WEBHOOK_PORT` | `positive int` | `443` | Public webhook port. |
| `WEBHOOK_SECRET_TOKEN` | `WEBHOOK_SECRET_TOKEN` | `string` | `""` | Optional Telegram webhook secret token. |
| `TELEGRAM_SUMMARY_ONLY` | `TELEGRAM_SUMMARY_ONLY` | `boolean` | `true` | Sends summary-first Telegram replies by default. |
| `TELEGRAM_PUSH_WHITELIST_ONLY` | `TELEGRAM_PUSH_WHITELIST_ONLY` | `boolean` | `true` | Restricts proactive Telegram pushes to whitelist flows by default. |
| `WEB_GUI_ENABLED` | `WEB_GUI_ENABLED` | `boolean` | `false` | When enabled, `WEB_GUI_HOST` and `WEB_GUI_TOKEN` become required. |
| `WEB_GUI_PORT` | `WEB_GUI_PORT` | `positive int` | `3000` | Web UI listen port. |
| `WEB_GUI_HOST` | `WEB_GUI_HOST` | `string` | `""` | Required when `WEB_GUI_ENABLED=true`. |
| `WEB_GUI_TOKEN` | `WEB_GUI_TOKEN` | `string` | `""` | Required when `WEB_GUI_ENABLED=true`. |
| `WEB_GUI_HTTPS` | `WEB_GUI_HTTPS` | `boolean` | `false` | When enabled, `TLS_CERT_PATH` and `TLS_KEY_PATH` become required. |
| `TLS_CERT_PATH` | `TLS_CERT_PATH` | `string` | `""` | Required when `WEB_GUI_HTTPS=true`. |
| `TLS_KEY_PATH` | `TLS_KEY_PATH` | `string` | `""` | Required when `WEB_GUI_HTTPS=true`. |
| `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` | `string` | Optional | Claude provider credential. |
| `OPENAI_API_KEY` | `OPENAI_API_KEY` | `string` | Optional | OpenAI/Codex provider credential. |
| `GEMINI_API_KEY` | `GEMINI_API_KEY` | `string` | Optional | Gemini provider credential. |
| `CURSOR_API_KEY` | `CURSOR_API_KEY` | `string` | Optional | Cursor provider credential. |
| `MERIDIAN_INTERNAL_BOOTSTRAP_KEY` | `MERIDIAN_INTERNAL_BOOTSTRAP_KEY` | `string` | Auto-generated by hub boot when missing | Single shared secret used by `deriveBuiltinCallerKey` to derive per-built-in caller keys. The hub boot path (`loadOrGenerateBootstrapKey` in `src/hub/server.ts`) reads `process.env`, generates 32 random bytes hex when absent, and appends `MERIDIAN_INTERNAL_BOOTSTRAP_KEY=<hex>` to `.env`. PM Blocker #1: if the key is missing AND `.env` is not writable, the hub fails fast — it never silently regenerates per boot. Rotating this value intentionally invalidates every built-in caller record on the next restart. `[ADDED 2026-05-05]` |
| `MERIDIAN_CALLER_KEYS` | `MERIDIAN_CALLER_KEYS` | `JSON string` | Optional | Legacy bootstrap import. When present and the persisted state has zero callers, the state-store seeds external callers from a JSON array of `{ caller_id, caller_label, caller_key }` entries. Not the source of truth after first boot — all subsequent mutations go through the admin API. `[ADDED 2026-05-05]` |

## Exports

**src/config.ts**

### `DEFAULT_AGENT_WORKDIR`
- **File**: `src/config.ts:7`
- **Purpose**: Provides the default working directory used when new agent runs do not specify one explicitly.
- **Implementation**: The constant resolves `process.cwd()` one level upward, which makes the runtime default to the parent of the current working directory instead of the repository subfolder the process was launched from.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `parseConfig(env: NodeJS.ProcessEnv = process.env): AppConfig`
- **File**: `src/config.ts:121`
- **Purpose**: Validates environment variables and returns the normalized Meridian runtime configuration object.
- **Implementation**: The function runs the private `envSchema` through `safeParse()`, collapses all Zod issues into one error string when validation fails, and otherwise returns the parsed values with defaults and transforms applied.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `config`
- **File**: `src/config.ts:134`
- **Purpose**: Exposes a module-level parsed configuration singleton for ordinary runtime imports.
- **Implementation**: The constant eagerly calls `parseConfig()` after `dotenv.config()` has loaded `.env` values, so any invalid environment shape fails fast during module import.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `AppConfig`
- **File**: `src/config.ts:135`
- **Purpose**: Types the validated configuration object shared across the rest of the codebase.
- **Implementation**: The alias is derived from `ReturnType<typeof parseConfig>`, which keeps the compile-time config shape aligned with the live parser output.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

**src/log-retention.ts**

### `LogInventoryEntry`
- **File**: `src/log-retention.ts:4`
- **Purpose**: Describes one discovered log file in a retention or inventory scan.
- **Implementation**: The interface captures the repo-relative path, byte size, last modification timestamp, and the normalized category used by retention policy decisions.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `LogInventory`
- **File**: `src/log-retention.ts:11`
- **Purpose**: Shapes the full inventory report returned from a recursive log-directory scan.
- **Implementation**: It records the scanned root, aggregate byte total, the sorted `LogInventoryEntry[]`, and the timestamp at which the inventory snapshot was generated.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `LogRetentionLogger`
- **File**: `src/log-retention.ts:18`
- **Purpose**: Defines the minimal structured logger contract needed by the retention worker.
- **Implementation**: The interface intentionally only requires `info()` and `warn()` methods that accept bindings plus a message, so the worker can run with a small pino-compatible surface instead of a full logger implementation.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `LogRetentionOptions`
- **File**: `src/log-retention.ts:23`
- **Purpose**: Configures the byte and age thresholds for one retention pass.
- **Implementation**: The shape carries the log root, separate active and session trim limits, the session max-age threshold, and an optional clock override for deterministic tests.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `LogRetentionWorkerOptions`
- **File**: `src/log-retention.ts:33`
- **Purpose**: Extends one-shot retention options with worker-loop controls.
- **Implementation**: It adds the `enabled` gate, repeating interval, and logger dependency required by `startLogRetentionWorker()` while inheriting all of the byte and age policy fields from `LogRetentionOptions`.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `LogRetentionResult`
- **File**: `src/log-retention.ts:44`
- **Purpose**: Summarizes what a retention pass removed or trimmed.
- **Implementation**: The result keeps separate arrays for deleted session logs and truncated files so callers can log or test each action independently.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `collectLogInventory(logDir: string, now: Date = new Date()): Promise<LogInventory>`
- **File**: `src/log-retention.ts:107`
- **Purpose**: Recursively scans a log directory and returns a sorted inventory snapshot.
- **Implementation**: The function walks subdirectories, keeps only `.log` files, classifies each entry as active, session, or other, sorts the results by size then path, and stamps the response with the supplied or current time.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `enforceLogRetention(options: LogRetentionOptions): Promise<LogRetentionResult>`
- **File**: `src/log-retention.ts:151`
- **Purpose**: Applies Meridian's retention policy by trimming oversized logs and removing expired session files.
- **Implementation**: It reuses the same recursive inventory scan, truncates active logs that exceed the configured max bytes, deletes stale session logs older than the configured age, and trims oversized session logs down to their keep-byte budget.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `startLogRetentionWorker(options: LogRetentionWorkerOptions): { stop: () => void }`
- **File**: `src/log-retention.ts:190`
- **Purpose**: Starts the background retention loop used by long-running Meridian processes.
- **Implementation**: The worker no-ops when disabled, runs one immediate pass, then schedules repeated passes with `setInterval()`, logging successful trims/removals and warnings for pass failures until `stop()` clears the timer.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

**src/logger.ts**

### `getRootLogger(): Logger`
- **File**: `src/logger.ts:61`
- **Purpose**: Returns the process-wide root logger instance.
- **Implementation**: The function lazily creates and caches a pino logger using pretty output in non-production environments, file transports in production, and no transport in Node's test runtime.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `createLogger(module: string, bindings: Record<string, unknown> = {}): Logger`
- **File**: `src/logger.ts:102`
- **Purpose**: Creates a child logger scoped to one Meridian module or subsystem.
- **Implementation**: In production it routes selected modules to dedicated file outputs and otherwise falls back to the shared root logger, then attaches the module name plus nullable trace and thread bindings on the returned child logger.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

**src/types.ts**

### `ChannelSchema`
- **File**: `src/types.ts:3`
- **Purpose**: Validates the set of supported ingress and reply channel names.
- **Implementation**: The enum is limited to `telegram`, `web`, and `socket`, which keeps channel routing strict across interface, hub, and web entrypoints.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `Channel`
- **File**: `src/types.ts:4`
- **Purpose**: Provides the TypeScript union for validated channel values.
- **Implementation**: The alias is inferred from `ChannelSchema`, so runtime validation and compile-time typing stay synchronized.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `BUILT_IN_INTENTS`
- **File**: `src/types.ts:6`
- **Purpose**: Enumerates Meridian's reserved hub intent names.
- **Implementation**: The readonly tuple is the single source of truth for built-in lifecycle, monitoring, service-registry, reply, and caller-registry intents, and it directly backs `BuiltInIntentSchema`. Added `register_caller`, `unregister_caller`, `rotate_caller_key`, `list_callers` in this round.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `BuiltInIntentSchema`
- **File**: `src/types.ts:37`
- **Purpose**: Validates the reserved intent names listed in `BUILT_IN_INTENTS`.
- **Implementation**: The schema wraps the tuple with `z.enum()`, ensuring the runtime validator and static tuple stay aligned.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `IntentSchema`
- **File**: `src/types.ts:38`
- **Purpose**: Validates any hub intent Meridian is willing to route.
- **Implementation**: The union accepts either a built-in intent or any non-empty string, which preserves compatibility with dynamically registered services while still protecting the empty-string case.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `Intent`
- **File**: `src/types.ts:39`
- **Purpose**: Provides the TypeScript view of the validated intent value.
- **Implementation**: The alias is inferred from `IntentSchema`, so the type tracks both built-in intents and custom service intent strings.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `BridgeModeSchema`
- **File**: `src/types.ts:41`
- **Purpose**: Validates the bridge execution modes used by Meridian threads.
- **Implementation**: The enum restricts mode selection to `bridge`, `pane_bridge`, and `stateless_call`, which downstream code uses to decide whether pane streaming is available.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `BridgeMode`
- **File**: `src/types.ts:42`
- **Purpose**: Provides the TypeScript union for bridge mode values.
- **Implementation**: The alias is inferred from `BridgeModeSchema`, keeping type-level mode checks aligned with runtime parsing.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `AgentTypeSchema`
- **File**: `src/types.ts:44`
- **Purpose**: Validates the provider IDs Meridian can spawn and track.
- **Implementation**: The enum is restricted to `claude`, `codex`, `gemini`, and `cursor`, which matches the agent implementations under `src/agents/`.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `AgentType`
- **File**: `src/types.ts:45`
- **Purpose**: Provides the TypeScript union for supported agent providers.
- **Implementation**: The alias is inferred from `AgentTypeSchema`, which keeps the compile-time provider set synchronized with the runtime validator.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `ReasoningEffortSchema`
- **File**: `src/types.ts:53`
- **Purpose**: Validates requested provider reasoning effort levels.
- **Implementation**: The enum constrains effort overrides to `low`, `medium`, `high`, or `xhigh`, which is reused by spawn flows and instance metadata.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `ReasoningEffort`
- **File**: `src/types.ts:54`
- **Purpose**: Provides the TypeScript union for reasoning effort values.
- **Implementation**: The alias is inferred from `ReasoningEffortSchema`, keeping effort typing aligned with runtime validation.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `HubResultStatusSchema`
- **File**: `src/types.ts:56`
- **Purpose**: Validates the top-level status attached to hub responses.
- **Implementation**: The enum normalizes result outcomes into `success`, `error`, `partial`, or `timeout`, which downstream renderers and routers can branch on predictably.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `HubResultStatus`
- **File**: `src/types.ts:57`
- **Purpose**: Provides the TypeScript union for normalized hub result status values.
- **Implementation**: The alias is inferred from `HubResultStatusSchema`, so type-level status checks follow the same four-state runtime contract.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `HubRunStateSchema`
- **File**: `src/types.ts:59`
- **Purpose**: Validates whether a run has completed or is still in flight.
- **Implementation**: The enum is separate from top-level status so partial replies can still say whether the run is `still_running`, `completed`, or timed out.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `HubRunState`
- **File**: `src/types.ts:60`
- **Purpose**: Provides the TypeScript union for run-state markers.
- **Implementation**: The alias is inferred from `HubRunStateSchema`, which keeps the compile-time and runtime state vocabulary synchronized.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `AgentInstanceStatusSchema`
- **File**: `src/types.ts:62`
- **Purpose**: Validates the lifecycle state stored for an agent instance.
- **Implementation**: The enum covers idle, active, waiting, stopped, and error states so instance managers and monitors share a stable vocabulary.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `AgentInstanceStatus`
- **File**: `src/types.ts:63`
- **Purpose**: Provides the TypeScript union for agent instance state.
- **Implementation**: The alias is inferred from `AgentInstanceStatusSchema`, preventing drift between runtime state parsing and TypeScript consumers.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `ThreadProgressEventKindSchema`
- **File**: `src/types.ts:65`
- **Purpose**: Validates the kind of structured thread progress update.
- **Implementation**: The enum distinguishes ordinary progress messages from approval prompts, which lets UIs render those two cases differently.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `ThreadProgressEventKind`
- **File**: `src/types.ts:66`
- **Purpose**: Provides the TypeScript union for progress event kinds.
- **Implementation**: The alias is inferred from `ThreadProgressEventKindSchema`, which keeps progress-kind typing aligned with the runtime validator.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `ThreadProgressPhaseSchema`
- **File**: `src/types.ts:68`
- **Purpose**: Validates the execution phase represented by a progress snapshot.
- **Implementation**: The enum limits phase values to `running` and `waiting_for_input`, matching the two partial-update states currently surfaced by Meridian.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `ThreadProgressPhase`
- **File**: `src/types.ts:69`
- **Purpose**: Provides the TypeScript union for progress phase values.
- **Implementation**: The alias is inferred from `ThreadProgressPhaseSchema`, keeping type-level handling in sync with runtime validation.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `ThreadProgressSnapshotSchema`
- **File**: `src/types.ts:71`
- **Purpose**: Validates the structured progress snapshot attached to partial hub results.
- **Implementation**: The object requires tracing, thread identity, provider, phase, waiting flag, and both raw plus display text, and it hard-codes `status` to `partial` so snapshots cannot masquerade as terminal results.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `ThreadProgressSnapshot`
- **File**: `src/types.ts:83`
- **Purpose**: Provides the TypeScript view of a validated progress snapshot.
- **Implementation**: The alias is inferred from `ThreadProgressSnapshotSchema`, so consumers of `HubResult.progress` share the same runtime-checked shape.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `FileAttachmentSchema`
- **File**: `src/types.ts:85`
- **Purpose**: Validates one file attachment reference carried through Meridian messages.
- **Implementation**: The object requires a path and optionally accepts a display filename and MIME type so attachments can be routed without requiring up-front file inspection.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `FileAttachment`
- **File**: `src/types.ts:102`
- **Purpose**: Provides the TypeScript shape of a validated attachment record.
- **Implementation**: The alias is inferred from `FileAttachmentSchema`, which keeps attachment typing aligned with runtime validation.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `TelegramInlineButtonSchema`
- **File**: `src/types.ts:114`
- **Purpose**: Validates one Telegram inline button payload.
- **Implementation**: The object requires button text and allows either a URL or callback data, then applies a refine rule that enforces exactly one of those action fields.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `TelegramInlineButton`
- **File**: `src/types.ts:123`
- **Purpose**: Provides the TypeScript shape for a validated Telegram inline button.
- **Implementation**: The alias is inferred from `TelegramInlineButtonSchema`, which keeps Telegram keyboard typing aligned with the runtime rule that only one action field is present.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `TelegramInlineKeyboardSchema`
- **File**: `src/types.ts:125`
- **Purpose**: Validates Telegram inline keyboard layouts included with hub results.
- **Implementation**: The object wraps a non-empty array of non-empty button rows, ensuring callers cannot emit structurally empty keyboard payloads.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `TelegramInlineKeyboard`
- **File**: `src/types.ts:128`
- **Purpose**: Provides the TypeScript shape of a validated inline keyboard.
- **Implementation**: The alias is inferred from `TelegramInlineKeyboardSchema`, which keeps keyboard typing and runtime validation synchronized.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `InboundUIEventSchema`
- **File**: `src/types.ts:130`
- **Purpose**: Validates the normalized inbound event shape used by interface adapters.
- **Implementation**: The object captures channel, sender, raw message identity, text, attachments, timestamp, and optional reply target so downstream code can treat Telegram and other UI inputs uniformly.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `InboundUIEvent`
- **File**: `src/types.ts:139`
- **Purpose**: Provides the TypeScript shape for a validated inbound UI event.
- **Implementation**: The alias is inferred from `InboundUIEventSchema`, which keeps interface-event typing aligned with the runtime parser contract.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `CompositeChatIdSchema`
- **File**: `src/types.ts:141`
- **Purpose**: Validates the modern channel-prefixed chat ID format.
- **Implementation**: The regex requires a lowercase channel prefix followed by `:` and an arbitrary trailing identifier, which lets one string carry both channel and chat identity.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `LegacyChatIdSchema`
- **File**: `src/types.ts:142`
- **Purpose**: Preserves validation for pre-channel chat IDs.
- **Implementation**: The schema requires a non-empty string that contains no colon, which keeps legacy chat references compatible without colliding with the newer composite format.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `SessionChatIdSchema`
- **File**: `src/types.ts:143`
- **Purpose**: Validates any chat ID that Meridian may persist in session state.
- **Implementation**: The union accepts either the newer composite format or the legacy single-segment format so session recovery can span both generations of IDs.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `SessionChatId`
- **File**: `src/types.ts:144`
- **Purpose**: Provides the TypeScript shape for a validated session chat ID.
- **Implementation**: The alias is inferred from `SessionChatIdSchema`, which keeps session chat typing aligned with the dual-format runtime parser.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `ReplyChannelSchema`
- **File**: `src/types.ts:146`
- **Purpose**: Validates how a hub result should be routed back to a caller.
- **Implementation**: The object carries the channel plus chat/message/bot metadata and an optional socket path for socket replies, giving the hub one normalized reply target across transports.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `ReplyChannel`
- **File**: `src/types.ts:156`
- **Purpose**: Provides the TypeScript shape for a validated reply channel descriptor.
- **Implementation**: The alias is inferred from `ReplyChannelSchema`, which keeps reply routing typing aligned with the runtime validator.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `CallerIdentitySchema`
- **File**: `src/types.ts:158`
- **Purpose**: Validates the caller identity token attached to hub messages and agent instances.
- **Implementation**: The object requires a lowercase-anchored `caller_id` (regex `^[a-z][a-z0-9_-]*$`) and optionally accepts a human-readable `caller_label` and a `caller_version` string. The schema is intentionally loose on the wire — the hub fills in `caller_label` from the registry after auth.
- **Dependencies**: None
- **Status**: `[ADDED 2026-05-05]`

### `CallerIdentity`
- **File**: `src/types.ts:163`
- **Purpose**: Provides the TypeScript shape for a validated caller identity record.
- **Implementation**: The alias is inferred from `CallerIdentitySchema`, keeping caller-identity typing aligned with the runtime validator across hub messages, agent instances, and IPC frames.
- **Dependencies**: None
- **Status**: `[ADDED 2026-05-05]`

### `HubPayloadSchema`
- **File**: `src/types.ts:165`
- **Purpose**: Validates the payload object carried inside a hub message.
- **Implementation**: The object starts with the content and attachment fields, then layers on optional spawn, model, approval, monitor, GUI, and push controls so different intents can share one envelope shape.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `HubPayload`
- **File**: `src/types.ts:185`
- **Purpose**: Provides the TypeScript shape for a validated hub payload.
- **Implementation**: The alias is inferred from `HubPayloadSchema`, which keeps payload typing aligned with the runtime message contract.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `PrioritySchema`
- **File**: `src/types.ts:187`
- **Purpose**: Validates numeric hub message priority.
- **Implementation**: The schema constrains values to integer priorities from `0` through `9`, which gives the router a bounded ordering key.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `Priority`
- **File**: `src/types.ts:188`
- **Purpose**: Provides the TypeScript type for validated priority values.
- **Implementation**: The alias is inferred from `PrioritySchema`, keeping type-level priority handling synchronized with the runtime constraint.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `OptionalUuidSchema`
- **File**: `src/types.ts:190`
- **Purpose**: Validates optional UUID-valued tracing fields.
- **Implementation**: The schema is reused for optional span identifiers so tracing fields across message, result, and monitor objects share one validation rule.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `HubMessageSchema`
- **File**: `src/types.ts:192`
- **Purpose**: Validates the full inbound message envelope routed through the hub.
- **Implementation**: The object requires tracing, thread, actor, intent, target, payload, mode, and reply-channel data, while making idempotency, span linkage, reply suppression, and caller identity optional and defaulting priority to `5`. Added optional `caller` field (R-01).
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `HubMessage`
- **File**: `src/types.ts:208`
- **Purpose**: Provides the input-side TypeScript shape for hub messages before defaults are applied.
- **Implementation**: The alias uses `z.input<typeof HubMessageSchema>` rather than `z.infer`, so callers may omit fields such as `priority` that the schema fills in during parsing.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `HubResultSchema`
- **File**: `src/types.ts:210`
- **Purpose**: Validates the full reply envelope returned from the hub.
- **Implementation**: The object combines tracing data, provider identity, content, optional run-state and summary/detail text, optional structured progress, attachments, optional Telegram keyboard markup, and a required timestamp.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `HubResult`
- **File**: `src/types.ts:225`
- **Purpose**: Provides the TypeScript shape for a validated hub result.
- **Implementation**: The alias is inferred from `HubResultSchema`, which keeps downstream result handling aligned with the runtime response validator.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `MonitorEventTypeSchema`
- **File**: `src/types.ts:227`
- **Purpose**: Validates monitor event categories emitted by health and streaming supervision.
- **Implementation**: The enum covers task completion, status changes, missed heartbeats, agent errors, and exhausted SSE reconnect attempts.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `MonitorEventType`
- **File**: `src/types.ts:234`
- **Purpose**: Provides the TypeScript union for monitor event category values.
- **Implementation**: The alias is inferred from `MonitorEventTypeSchema`, so monitor handlers and serializers share the same runtime-checked event names.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `MonitorModeSchema`
- **File**: `src/types.ts:236`
- **Purpose**: Validates which monitoring transport produced an event.
- **Implementation**: The enum is limited to `sse_hook` and `heartbeat`, which matches the monitor subsystem's two collection strategies.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `MonitorMode`
- **File**: `src/types.ts:237`
- **Purpose**: Provides the TypeScript union for monitor mode values.
- **Implementation**: The alias is inferred from `MonitorModeSchema`, keeping monitor-mode typing synchronized with the runtime validator.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `MonitorEventSchema`
- **File**: `src/types.ts:239`
- **Purpose**: Validates structured events emitted by the monitor subsystem.
- **Implementation**: The object requires thread identity, event type, mode, and timestamp, then optionally carries trace/span data, agent status metadata, reconnect counters, arbitrary details, and a free-form error string.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `MonitorEvent`
- **File**: `src/types.ts:255`
- **Purpose**: Provides the TypeScript shape for a validated monitor event.
- **Implementation**: The alias is inferred from `MonitorEventSchema`, which keeps telemetry typing aligned with the runtime monitoring contract.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `AgentInstanceSchema`
- **File**: `src/types.ts:257`
- **Purpose**: Validates the persisted and in-memory shape of one tracked agent instance.
- **Implementation**: The object captures thread/provider identity, optional model and reasoning metadata, bridge mode, socket path, working directory, process and pane state, lifecycle status, creation time, restart safety, the defaulted auto-approve flag, and optional caller tracking fields (`spawned_by`, `last_caller`, `last_caller_at`) added in R-01.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `AgentInstance`
- **File**: `src/types.ts:281`
- **Purpose**: Provides the input-side TypeScript shape for an agent instance record.
- **Implementation**: The alias uses `z.input<typeof AgentInstanceSchema>` so callers can supply partially defaulted data, including omitted `auto_approve`, before the schema normalizes it.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-05-05]`

### `PaneSubscribeRequestSchema`
- **File**: `src/types.ts:283`
- **Purpose**: Validates pane-output subscribe requests.
- **Implementation**: The object requires the literal request type plus a thread ID and optional replay-line count, which gives the pane broadcaster enough information to attach and optionally backfill output.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `PaneSubscribeRequest`
- **File**: `src/types.ts:288`
- **Purpose**: Provides the TypeScript shape for a validated pane subscribe request.
- **Implementation**: The alias is inferred from `PaneSubscribeRequestSchema`, which keeps pane-subscription typing aligned with the runtime validator.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `PaneOutputChunkSchema`
- **File**: `src/types.ts:290`
- **Purpose**: Validates one incremental pane output packet.
- **Implementation**: The object requires the `pane_output` literal, thread ID, and text chunk, then optionally carries cursor, timestamp, and tracing fields for richer streaming clients.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `PaneOutputChunk`
- **File**: `src/types.ts:299`
- **Purpose**: Provides the TypeScript shape for a validated pane output packet.
- **Implementation**: The alias is inferred from `PaneOutputChunkSchema`, so pane-stream consumers share the same runtime-checked structure.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `PaneOutputNotAvailableSchema`
- **File**: `src/types.ts:301`
- **Purpose**: Validates the negative reply sent when pane output cannot be streamed.
- **Implementation**: The object requires the `not_available` literal, a thread ID, and a human-readable reason so clients can fail gracefully instead of waiting for output that will never arrive.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `PaneOutputNotAvailable`
- **File**: `src/types.ts:306`
- **Purpose**: Provides the TypeScript shape for a negative pane-output response.
- **Implementation**: The alias is inferred from `PaneOutputNotAvailableSchema`, which keeps fallback pane-stream typing aligned with runtime validation.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `PaneUnsubscribeRequestSchema`
- **File**: `src/types.ts:308`
- **Purpose**: Validates pane-output unsubscribe requests.
- **Implementation**: The object only needs the literal request type and thread ID, which is enough for the broadcaster to tear down a subscription.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `PaneUnsubscribeRequest`
- **File**: `src/types.ts:312`
- **Purpose**: Provides the TypeScript shape for a validated pane unsubscribe request.
- **Implementation**: The alias is inferred from `PaneUnsubscribeRequestSchema`, keeping pane-unsubscribe typing aligned with the runtime validator.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `ProviderModelSchema`
- **File**: `src/types.ts:314`
- **Purpose**: Validates one provider model option advertised to a user.
- **Implementation**: The object is intentionally minimal and only requires a stable model ID plus a human-readable label.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `ProviderModel`
- **File**: `src/types.ts:318`
- **Purpose**: Provides the TypeScript shape for a validated provider model option.
- **Implementation**: The alias is inferred from `ProviderModelSchema`, which keeps model-option typing aligned with runtime validation.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `ProviderModelCatalogSchema`
- **File**: `src/types.ts:320`
- **Purpose**: Validates the model catalog returned for one provider thread.
- **Implementation**: The object ties a thread and provider to the current selected model ID, defaulting that field to `null`, and a list of `ProviderModelSchema` entries.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `ProviderModelCatalog`
- **File**: `src/types.ts:326`
- **Purpose**: Provides the TypeScript shape for a validated provider model catalog.
- **Implementation**: The alias is inferred from `ProviderModelCatalogSchema`, keeping model-catalog typing aligned with the runtime contract.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `ServiceEndpointSchema`
- **File**: `src/types.ts:342`
- **Purpose**: Validates one service-registry endpoint record.
- **Implementation**: The object accepts an optional friendly service name, required socket path, a defaulted list of intents, and arbitrary metadata so the hub can register internal or external socket services uniformly.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

### `ServiceEndpoint`
- **File**: `src/types.ts:348`
- **Purpose**: Provides the TypeScript shape for a validated service endpoint record.
- **Implementation**: The alias is inferred from `ServiceEndpointSchema`, which keeps service-registry typing aligned with runtime validation.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T15:06:30+09:00]`

## Test Files

- `src/config.test.ts`
- `src/log-retention.test.ts`
- `src/types.test.ts`
