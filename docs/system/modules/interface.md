# interface
**Source**: `src/interface/`
**Summary**: Telegram ingress, slash-command parsing, interactive picker flows, webhook/long-poll startup, and channel adapters that bridge interface events to hub messages and outbound replies.
**Last Scanned**: `2026-04-08T14:23:07+09:00`
**Exports Documented**: 28

`src/interface/index.ts` is the runtime entrypoint for the Telegram interface. On module load it attaches auth, message, and callback handlers to the default `botRuntimes`, installs shutdown hooks, and autostarts unless `MERIDIAN_DISABLE_INTERFACE_AUTOSTART` is set to `"true"`.

## Slash Command Registry

`src/interface/slash-handler.ts` parses 19 slash commands, while `src/interface/bot.ts` registers 17 Telegram menu commands through `setMyCommands()`. `/autoapprove` and `/push` are supported by the parser and help text but are not part of the synced Telegram command list.

| Command | Parsed Intent / Flow | Forwarded | Notes |
|--------|------|---------|--------|
| `/spawn` | `spawn` | Yes | Validates `type` and `mode`; a bare `/spawn` opens provider, mode, and directory pickers rooted at `config.AGENT_WORKDIR`. |
| `/restart` | `service_restart` | No | Opens an inline restart menu that launches shell scripts via `tmux` first and detached `nohup` as fallback. |
| `/browse` | `browse` | No | Opens a repo-root browser and replies with the exact selected folder or file path. |
| `/kill` | `kill` | Yes | Uses `thread=` when provided or opens a live-thread picker. |
| `/info` | `status` | Yes | Alias for the active attachment status lookup. |
| `/status` | `status` | Yes | Requires `thread=<thread_id>`. |
| `/attach` | `attach` | Yes | Uses `thread=` directly or an attachable-thread picker when omitted. |
| `/detach` | `detach` | Yes | Detaches the current chat from the explicit or active thread binding. |
| `/reboot` | `reboot` | Yes | Requires `thread=<thread_id>`; inline hub action buttons also route here. |
| `/gui` | `gui` | Yes | Requests the GUI link for an explicit or active thread. |
| `/approve` | `terminal_input` | Yes | Normalizes approval selections and forwards them as terminal input. |
| `/autoapprove` | `set_auto_approve` or `status` | Yes | `on` and `off` toggle auto-approve; `status` reuses the `status` intent with an auto-approve query flag. |
| `/model` | `switch_model` picker | Indirect | Never forwards immediately; it opens a model picker and callback selection sends the chosen model ID. |
| `/detail` | `detail` | Yes | Optional `trace=<trace_id>` targets a specific cached run result. |
| `/update` | `monitor_update` | Yes | Accepts `on` or `off` plus interval aliases such as `interval=`, `every=`, `sec=`, or a bare positive integer. |
| `/mupdate` | `monitor_manual_update` | Yes | Requests a single manual progress update for the thread. |
| `/push` | `push` | Yes | Toggles proactive Telegram push delivery for a thread. |
| `/list` | `list` | Yes | Lists live instances globally. |
| `/help` | `help` | No | Replies with static command usage and approval help text. |

Free text without a slash is treated as `run` intent. When a Telegram message replies to an existing Meridian message, normalized approvals, numeric selections, `yes`/`no`, and `/model` are treated as `terminal_input` for the active thread.

## Exports

**src/interface/adapters/telegram-adapter.ts**

### `splitTextForTelegram(content: string, limit = TELEGRAM_SAFE_TEXT_LIMIT): string[]`
- **File**: `src/interface/adapters/telegram-adapter.ts:69`
- **Purpose**: Splits long Telegram text into delivery-safe chunks below the configured character limit.
- **Implementation**: It prefers newline boundaries when chunking, but falls back to a hard split when no useful newline appears in the current window. Empty input returns an empty array, and non-positive limits throw immediately.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `decorateTelegramResultText(result: HubResult): string`
- **File**: `src/interface/adapters/telegram-adapter.ts:219`
- **Purpose**: Converts a raw hub result into the Telegram-facing text body used when full output is sent directly.
- **Implementation**: It strips Meridian framing and summary protocol tags, falls back to `/detail` for empty content, and appends the approval hint only when the result is an approval prompt. This keeps normal replies compact while preserving actionable approval affordances.
- **Dependencies**: `shared/approval`, `types`
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `resolveTelegramDetailRecord`
- **File**: `src/interface/adapters/telegram-adapter.ts:277`
- **Purpose**: Looks up the cached Telegram detail payload for a chat and optional bot, trace, or thread selector.
- **Implementation**: The cache is keyed by `(bot_id, chat_id)` and stores the most recent summary/detail pairs per trace. Lookup prefers an exact trace match, then a thread match, then the newest cached record.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `shouldPushTelegramProactive(result: HubResult): boolean`
- **File**: `src/interface/adapters/telegram-adapter.ts:301`
- **Purpose**: Decides whether Meridian should proactively push a Telegram update without an explicit user pull.
- **Implementation**: It allows all pushes when whitelist-only mode is disabled, always pushes errors and approval prompts, and otherwise looks for completion-oriented text markers before sending. This gate is used to avoid noisy proactive updates in restricted mode.
- **Dependencies**: `config`, `shared/approval`, `types`
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `TelegramAdapterOptions`
- **File**: `src/interface/adapters/telegram-adapter.ts:318`
- **Purpose**: Configures the default bot token or multi-bot token list for Telegram result delivery.
- **Implementation**: The options let callers inject a single token or a pre-resolved token set instead of reading from global config. `TelegramChannelAdapter` uses the chosen tokens to resolve per-bot delivery at runtime.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `TelegramChannelAdapter`
- **File**: `src/interface/adapters/telegram-adapter.ts:360`
- **Purpose**: Implements the hub `ChannelAdapter` contract for Telegram delivery, including text, file, summary, and retry behavior.
- **Implementation**: It resolves the correct bot token for a reply channel, derives summary and detail bodies, caches detail text for `/detail`, suppresses duplicate deliveries inside a short window, and retries rate-limited or transient API failures with backoff. Oversized text is written to a temporary file and uploaded as a document, and hub attachments are forwarded after the main message.
- **Dependencies**: `config`, `hub/channel-adapter`, `logger`, `shared/approval`, `types`
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

**src/interface/adapters/web-adapter.ts**

### `WebChannelAdapter`
- **File**: `src/interface/adapters/web-adapter.ts:5`
- **Purpose**: Satisfies the hub adapter interface for web reply channels.
- **Implementation**: It only claims reply channels where `channel === "web"` and logs that actual web delivery happens through SSE or WebSocket paths instead of direct adapter sends. The class therefore acts as a routing placeholder rather than a transport implementation.
- **Dependencies**: `hub/channel-adapter`, `logger`, `types`
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

**src/interface/auth.ts**

### `authMiddleware`
- **File**: `src/interface/auth.ts:12`
- **Purpose**: Enforces the Telegram sender whitelist before any interface message is processed.
- **Implementation**: It extracts the raw Telegram message ID for logging, rejects senders not present in `config.ALLOWED_USER_IDS`, emits a structured warning, and replies with `Access denied.` when a chat is available. Authorized traffic falls through to the next Grammy middleware.
- **Dependencies**: `config`, `logger`
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

**src/interface/bot.ts**

### `TelegramBotRuntime`
- **File**: `src/interface/bot.ts:58`
- **Purpose**: Describes one configured Telegram bot instance together with its stable bot ID and raw token.
- **Implementation**: The runtime tuple is the shared shape used when command syncing and interface startup fan out across one or more bots. It keeps the live `Bot` object paired with the parsed Telegram `bot_id`.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `botRuntimes`
- **File**: `src/interface/bot.ts:78`
- **Purpose**: Exposes the deduplicated set of configured Telegram bot runtimes used by the interface layer.
- **Implementation**: The file resolves the primary token plus any comma-separated extras from config, instantiates a `grammy` `Bot` for each token, extracts the numeric bot ID, and throws if two configured tokens map to the same bot ID.
- **Dependencies**: `config`
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `syncBotCommands(): Promise<void>`
- **File**: `src/interface/bot.ts:80`
- **Purpose**: Synchronizes Meridian's curated command list to every configured Telegram bot.
- **Implementation**: It issues `setMyCommands()` concurrently for each runtime using the shared `BOT_COMMANDS` array. The synced list exposes the user-facing Telegram command menu for the most common slash flows.
- **Dependencies**: `config`
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

**src/interface/index.ts**

### `InterfaceBotRuntime`
- **File**: `src/interface/index.ts:72`
- **Purpose**: Defines the minimal bot runtime contract accepted by `startInterface()`.
- **Implementation**: The exported interface intentionally abstracts the concrete `grammy` bot behind a smaller shape so startup can be dependency-injected in tests. It carries the runtime bot instance plus the resolved `botId`.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `InterfaceLogger`
- **File**: `src/interface/index.ts:77`
- **Purpose**: Defines the logger methods that interface startup needs when an alternate logger is injected.
- **Implementation**: The contract is limited to `info`, `warn`, and `error`, which is enough for both polling and webhook startup paths as well as webhook request failure logging. This keeps tests from depending on the repo's concrete logger implementation.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `toHubMessage(parsedCommand: ParsedSlashCommand, payload): HubMessage`
- **File**: `src/interface/index.ts:201`
- **Purpose**: Converts a parsed Telegram command plus normalized inbound payload into the hub transport envelope.
- **Implementation**: It rejects local-only commands such as `help`, `service_restart`, and `browse`, derives the effective thread and target from explicit arguments or reply context, normalizes auto-approve payloads, and emits a fresh `trace_id` with reply-channel metadata. Attachments, monitor toggles, spawn directory, and reply linkage are all carried into the hub payload.
- **Dependencies**: `interface/parser`, `interface/slash-handler`, `types`
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `buildSpawnDirectoryKeyboard(session): InlineKeyboard`
- **File**: `src/interface/index.ts:416`
- **Purpose**: Builds the inline keyboard used by the interactive spawn-directory picker.
- **Implementation**: The keyboard always exposes select, create-folder, up, and cancel actions, then appends one button per child directory in the current session snapshot. Callback payloads encode the session ID and entry index so later handlers can validate ownership and replay the flow safely.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `handleHubActionCallbackData(data: string, ctx: Context, options: HubActionCallbackHandlerOptions = {}): Promise<boolean>`
- **File**: `src/interface/index.ts:1337`
- **Purpose**: Handles inline callback buttons that request hub-level reboot or kill actions for a specific thread.
- **Implementation**: It parses the callback payload through `shared/telegram-controls`, reconstructs Telegram actor and reply metadata from the callback context, and dispatches a synthetic hub action message through either the injected dispatcher or the default IPC sender. Successful handling answers the callback query with a thread-specific status message and returns `true`.
- **Dependencies**: `interface/ipc-sender`, `interface/parser`, `shared/telegram-controls`, `types`
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `buildWebhookRoutePath(webhookUrl: string, botId: string, runtimeCount: number): string`
- **File**: `src/interface/index.ts:1501`
- **Purpose**: Computes the HTTP path that should receive webhook traffic for a bot runtime.
- **Implementation**: It normalizes the base pathname from `WEBHOOK_URL`, defaulting to `/webhook` when the URL path is empty, and appends the bot ID only when multiple runtimes share the same server. This lets a single listener multiplex one or many Telegram bots safely.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `buildWebhookPublicUrl(webhookUrl: string, botId: string, runtimeCount: number): string`
- **File**: `src/interface/index.ts:1506`
- **Purpose**: Produces the external webhook URL Telegram should call for a bot runtime.
- **Implementation**: It clones the configured webhook URL, replaces only the pathname with the route computed by `buildWebhookRoutePath()`, and clears query and hash fragments. The resulting URL is what `setWebhook()` receives during webhook startup.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `startInterface(options: StartInterfaceOptions = {}): Promise<void>`
- **File**: `src/interface/index.ts:1600`
- **Purpose**: Starts the Telegram interface by syncing commands and then choosing long polling or webhook mode for the configured runtimes.
- **Implementation**: It resolves defaults from config, allows callers to inject runtimes, logging, server construction, and webhook handler factories, then syncs bot commands before starting either polling or a webhook multiplexer. The surrounding module wires auth middleware, message parsing, slash handling, picker callbacks, and shutdown hooks up front, so `startInterface()` only has to activate transport. [UPDATED 2026-05-05] At boot, derives the single shared `meridian-telegram` caller key via `deriveBuiltinCallerKey` and calls `setCallerIdentity` on the default IPC sender (single shared id per PM Blocker #3 — no per-bot ids). Throws `bootstrap_key_missing` if `MERIDIAN_INTERNAL_BOOTSTRAP_KEY` is absent.
- **Dependencies**: `config`, `interface/auth`, `interface/bot`, `interface/ipc-sender`, `shared/caller-bootstrap`, `interface/parser`, `interface/slash-handler`
- **Status**: `[UPDATED 2026-05-05]`

**src/interface/ipc-sender.ts**

### `IpcSender`
- **File**: `src/interface/ipc-sender.ts:23`
- **Purpose**: Stateful sender that wraps every outbound IPC `HubMessage` in the `{ auth, message }` wire envelope after a caller identity has been registered.
- **Implementation**: The class accepts an optional `socketPath` (defaults to `config.HUB_SOCKET_PATH`), exposes `setCallerIdentity` / `clearCallerIdentity` / `hasCallerIdentity`, and refuses to `send` / `request` / `requestRun` until an identity is set (throws `caller_identity_not_set`). Each outbound payload is built via `wrapHubMessage` from `shared/caller-wire`, which both stamps the auth envelope with `caller_id` + `caller_key` and injects `message.caller = { caller_id, caller_label, caller_version? }` so receivers see the structured identity without ever seeing the secret key.
- **Dependencies**: `config`, `logger`, `shared/caller-wire`, `shared/ipc`, `types`
- **Status**: `[ADDED 2026-05-05]`

### `setCallerIdentity(args: CallerIdentitySetterArgs): void`
- **File**: `src/interface/ipc-sender.ts:94`
- **Purpose**: Registers the caller identity used by every subsequent send on the default singleton sender.
- **Implementation**: Validates the trio `caller_id` / `caller_key` / `caller_label` (all required; empty strings rejected with `caller_identity_required`) plus an optional `caller_version`, and stores them on the module's default `IpcSender` instance. Subprocess entrypoints (web, CLI, telegram, monitor) call this once at boot before any send.
- **Dependencies**: `shared/caller-wire`
- **Status**: `[ADDED 2026-05-05]`

### `sendHubMessage(message: HubMessage): Promise<void>`
- **File**: `src/interface/ipc-sender.ts:106`
- **Purpose**: Sends a one-way interface-to-hub message wrapped in the wire envelope.
- **Implementation**: Delegates to the default `IpcSender` singleton, which writes `{ auth: { caller_id, caller_key }, message }` to `config.HUB_SOCKET_PATH` and emits a debug log including the trace, thread, intent, target, and resolved `caller_id`. Throws `caller_identity_not_set` when called before `setCallerIdentity`.
- **Dependencies**: `config`, `logger`, `shared/caller-wire`, `shared/ipc`, `types`
- **Status**: `[UPDATED 2026-05-05]`

### `requestHubMessage(message: HubMessage, timeoutMs?: number): Promise<HubResult>`
- **File**: `src/interface/ipc-sender.ts:110`
- **Purpose**: Sends a request-response IPC message wrapped in the wire envelope and validates the returned result.
- **Implementation**: Delegates to the default `IpcSender` singleton, sending the wrapped envelope through `sendIpcRequest()` and parsing the response through `HubResultSchema`. Picker flows use this helper for `/list` and `/model` lookups that need immediate data rather than fire-and-forget delivery.
- **Dependencies**: `config`, `shared/caller-wire`, `shared/ipc`, `types`
- **Status**: `[UPDATED 2026-05-05]`

### `requestHubRunMessage(message: HubMessage): Promise<HubResult>`
- **File**: `src/interface/ipc-sender.ts:117`
- **Purpose**: Same as `requestHubMessage` but raises the IPC timeout to `IPC_RUN_REQUEST_TIMEOUT_MS` for `/api/run`-class long calls.
- **Implementation**: Thin wrapper over the default `IpcSender.requestRun`, which forwards the envelope-wrapped message with the long timeout.
- **Dependencies**: `shared/caller-wire`, `shared/ipc`, `types`
- **Status**: `[ADDED 2026-05-05]`

**src/interface/parser.ts**

### `ParsedInboundEvent`
- **File**: `src/interface/parser.ts:10`
- **Purpose**: Captures the normalized Telegram envelope that the rest of the interface layer consumes.
- **Implementation**: The shape carries stable chat, bot, actor, and display-name metadata together with a Meridian `InboundUIEvent`. `index.ts` uses this as the handoff from raw `grammy` context into slash parsing and hub message construction.
- **Dependencies**: `types`
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `formatTelegramChatId(chatId: string | number): string`
- **File**: `src/interface/parser.ts:183`
- **Purpose**: Normalizes a Telegram chat ID into Meridian's reply-channel chat identifier format.
- **Implementation**: It simply prefixes the raw numeric or string Telegram ID with `telegram:` so downstream components can treat it as a typed channel identifier. Callback handlers and parsed inbound events both use this helper.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `formatTelegramActorId(userId: string | number): string`
- **File**: `src/interface/parser.ts:187`
- **Purpose**: Normalizes a Telegram user ID into Meridian's actor ID namespace.
- **Implementation**: It prefixes the sender ID with `tg:` and returns the result as a string. This keeps actor IDs distinct from other channels while remaining deterministic across messages.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `parseTelegramMessage(ctx: Context): Promise<ParsedInboundEvent | null>`
- **File**: `src/interface/parser.ts:191`
- **Purpose**: Converts a raw Telegram message context into the normalized Meridian event payload used by the interface runtime.
- **Implementation**: It rejects empty contexts, requires a sender ID, extracts text or caption content, downloads photo and document attachments into `/tmp/hub-attachments`, and fills reply-to plus display-name metadata. The resulting object packages the Telegram envelope with a timestamped `InboundUIEvent` ready for slash parsing or free-text forwarding.
- **Dependencies**: `types`
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

**src/interface/slash-handler.ts**

### `ParsedSlashCommand`
- **File**: `src/interface/slash-handler.ts:7`
- **Purpose**: Defines the normalized command shape shared between slash parsing, picker flows, and hub message conversion.
- **Implementation**: The record carries the parsed intent, forwarding flag, target and thread selection, spawn directory, monitor and push toggles, picker state, priority, and auto-approve metadata. `index.ts` relies on this shape to decide whether a command is local-only, picker-driven, or forwarded to the hub.
- **Dependencies**: `types`
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `getHelpMessage(): string`
- **File**: `src/interface/slash-handler.ts:194`
- **Purpose**: Returns the static help text for the Telegram interface.
- **Implementation**: The message enumerates supported slash commands, their key arguments, the approval-selection help text, and the fallback rule that free text becomes a run intent. `index.ts` replies with this content for `/help` and other local help cases.
- **Dependencies**: `shared/approval`
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

### `parseSlashCommand(rawContent: string): ParsedSlashCommand`
- **File**: `src/interface/slash-handler.ts:198`
- **Purpose**: Parses Telegram text into either a free-text run request or a validated structured slash command.
- **Implementation**: It normalizes alternate slash characters, supports both `key=value` and loose positional argument forms, validates provider, mode, thread, approval, interval, and auto-approve inputs, and maps each command to either a forwardable hub intent or a local picker/help/restart flow. Commands such as `/spawn`, `/attach`, `/kill`, and `/model` encode picker hints so `index.ts` can launch interactive selection UIs instead of forwarding immediately.
- **Dependencies**: `shared/approval`, `types`
- **Status**: `[ADDED 2026-04-08T14:23:07+09:00]`

## Test Files

- `src/interface/index.test.ts`
- `src/interface/parser.test.ts`
- `src/interface/slash-handler.test.ts`
