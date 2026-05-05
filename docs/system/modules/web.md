# web
**Source**: `src/web/`
**Summary**: Authenticated HTTP and WebSocket endpoints plus static hub, terminal, and bridge pages for spawning agents, browsing logs and files, editing working trees, and streaming pane output.
**Last Scanned**: `2026-05-05T00:00:00+09:00` `[UPDATED 2026-05-05]`
**Exports Documented**: 18

`src/web/server.ts` serves the `public/` bundle directly and allows those static assets to load without auth so the pages can render their own missing-token states. Every `/api/*` route and `/ws/terminal` still requires the GUI token via `Authorization: Bearer <token>` or `?token=`, and session identity is resolved from `x-session-id`, `session_id`, or the `meridian_session` cookie before hub messages are built.

## Public HTTP Boundary Contract

The `/api/*` routes are the canonical public control surface for Meridian. External clients (Meridian GUI, Meridian CLI, and Meridian-roles) depend only on these JSON request/response shapes. The Hub Unix socket and raw `HubMessage` payload shapes are private to Meridian; the server helpers in `src/web/server.ts` translate between the HTTP contract and Hub messages so callers never need socket paths, raw `intent` payloads, or detached `run` transport details.

Approval policy is a neutral boundary field (`auto_approve: boolean` on `/api/spawn`, `enabled: boolean` on `/api/autoapprove`).

Caller identity for hub attribution follows the canonical HTTP headers (per Playbook §3.7): `X-Meridian-Caller-Id`, `X-Meridian-Caller-Key`, `X-Meridian-Caller-Version`. External callers (CLI, automation) may include these headers on any request; the web server reads them via `callerEnvelopeFromHttpHeaders` (from `shared/caller-wire`) and attaches the extracted caller identity to the forwarded hub message. Currently only `/api/spawn` propagates the inbound caller to the hub; admin routes (`/api/callers*`) always sign as `meridian-admin` regardless of inbound headers. `[UPDATED 2026-05-05]` Meridian is the single place that maps the policy into provider-specific CLI flags — `--dangerously-bypass-approvals-and-sandbox` for Codex (`src/agents/codex.ts:39`, `src/agents/codex.ts:52`, `src/agents/codex.ts:68`) and `--dangerously-skip-permissions` for Claude (`src/agents/claude.ts:29`, `src/agents/claude.ts:63`). External callers must never ship provider CLI flags through the API.

## Endpoint Inventory

All API routes return JSON. Hub-backed routes construct `reply_channel.channel = "web"` messages so the web UI behaves like a first-class Meridian interface instead of a special-case transport.

### HTTP Routes

| Path | Method | Purpose | Upstream / Validation | Key refs |
|--------|------|---------|--------|--------------|
| `/api/instances` | `GET` | Returns the live instance list used by the hub dashboard, bridge page, and terminal bootstrapping. | Sends `intent: "list"` with `thread_id: "global"` / `target: "all"` and JSON-parses the hub payload. | `src/web/server.ts:568`, `src/web/server.ts:691` |
| `/api/health` | `GET` | Returns a lightweight health payload with `ok`, package version, hub-socket uptime, and live agent count. | Reuses the global `list` query, converts hub failures to `503`, and derives uptime from the socket file timestamp. | `src/web/server.ts:573`, `src/web/server.ts:708` |
| `/api/logs` | `GET` | Returns categorized log inventory for the dashboard log monitor. | Reads the log directory locally through `collectLogInventory()`. | `src/web/server.ts:578`, `src/web/server.ts:737` |
| `/api/log_file` | `GET` | Returns a specific log file, truncating very large files to the last `2 MiB` for browser viewing. | Validates `path`, keeps reads under `logDir`, and maps traversal / not-found / directory errors to JSON responses. | `src/web/server.ts:583`, `src/web/server.ts:742` |
| `/api/log_file/clear` | `POST` | Truncates a `.log` file from the dashboard. | Validates `{ path }`, requires a `.log` suffix, keeps writes under `logDir`, and logs successful clears. | `src/web/server.ts:588`, `src/web/server.ts:775` |
| `/api/run` | `POST` | Sends a normal agent run request, optionally with attachments and an explicit thread selector. | Validates `{ thread_id?, content, attachments[] }`, defaults missing thread IDs to `active`, and forwards `intent: "run"`. | `src/web/server.ts:593`, `src/web/server.ts:806` |
| `/api/kill` | `POST` | Kills the selected or active thread. | Uses the shared thread-action handler with `intent: "kill"`. | `src/web/server.ts:598`, `src/web/server.ts:826` |
| `/api/reboot` | `POST` | Reboots the selected or active thread. | Uses the shared thread-action handler with `intent: "reboot"`. | `src/web/server.ts:603`, `src/web/server.ts:826` |
| `/api/detach` | `POST` | Detaches the current web session from the selected or active thread. | Uses the shared thread-action handler with `intent: "detach"`. | `src/web/server.ts:608`, `src/web/server.ts:826` |
| `/api/spawn_repos/browse` | `GET` | Browses nested directories under `config.AGENT_WORKDIR` for the workspace picker dialog. | Validates the optional `relative` query, blocks traversal, returns only visible subdirectories, and reports `parent_relative` for the Up button. | `src/web/server.ts:613`, `src/web/server.ts:923` |
| `/api/spawn_repos` | `GET` | Returns the first page of top-level spawnable repo directories under `config.AGENT_WORKDIR`. | Reads the agent workdir locally, keeps only directories, sorts names, and limits the list to `64`. | `src/web/server.ts:618`, `src/web/server.ts:849` |
| `/api/spawn` | `POST` | Spawns a new GUI-linked agent session. | Validates provider/mode/model/effort/auto-approve input, resolves `repo` or `spawn_dir` under `config.AGENT_WORKDIR`, forwards the browser host override, and sends `intent: "spawn"`. When `X-Meridian-Caller-Id` and `X-Meridian-Caller-Key` headers are present (`callerEnvelopeFromHttpHeaders`), attaches the inbound caller identity so the hub records `spawned_by` on the new instance. `[UPDATED 2026-05-05]` | `src/web/server.ts:623`, `src/web/server.ts:865` |
| `/api/files` | `GET` | Lists a thread working tree for the terminal file explorer. | Validates `thread_id` and `depth`, resolves the instance working directory via the hub `list` payload, then walks the filesystem while skipping dotfiles. | `src/web/server.ts:628`, `src/web/server.ts:1011` |
| `/api/history` | `GET` | Returns persisted history entries for one thread. | Validates `thread_id` and forwards `intent: "history"` for that thread. | `src/web/server.ts:633`, `src/web/server.ts:1036` |
| `/api/history_threads` | `GET` | Returns the session-history index used by the terminal sidebar. | Reuses global `intent: "history"` with `thread_id: "global"` / `target: "all"`. | `src/web/server.ts:638`, `src/web/server.ts:1056` |
| `/api/progress/:thread_id` | `GET` | Returns a normalized progress snapshot for quiet periods when pane output is not arriving. | Decodes the path segment, forwards `intent: "monitor_manual_update"`, maps missing sessions to `404`, and coerces legacy partial hub results into `ThreadProgressSnapshotSchema`. | `src/web/server.ts:643`, `src/web/server.ts:1073` |
| `/api/file` | `GET` | Reads a file from the selected thread working tree into the editor. | Validates `thread_id` and `path`, resolves the working directory from the hub `list` payload, and blocks path escape with `resolvePathWithinRoot()`. | `src/web/server.ts:648`, `src/web/server.ts:1023` |
| `/api/file` | `POST` | Writes edited file contents back into the selected thread working tree. | Validates `{ thread_id, path, content }`, resolves the working directory from the hub `list` payload, creates missing parent directories, and writes UTF-8 content. | `src/web/server.ts:653`, `src/web/server.ts:1100` |
| `/api/terminal_input` | `POST` | Sends raw terminal or approval input to the agent without opening a new run. | Validates `{ thread_id?, content }`, defaults missing thread IDs to `active`, and forwards `intent: "terminal_input"`. | `src/web/server.ts:658`, `src/web/server.ts:1110` |
| `/api/push` | `POST` | Enables, disables, or queries proactive push delivery for the selected thread. | Validates `{ thread_id?, enabled? }` and sends a manually assembled `intent: "push"` hub message with `payload.push_enabled`. | `src/web/server.ts:663`, `src/web/server.ts:1177` |
| `/api/models` | `GET` | Returns the provider model catalog for a thread. | Validates `thread_id`, forwards `intent: "list_models"`, and falls back to current-model metadata from live or historical instance records if catalog lookup fails. | `src/web/server.ts:668`, `src/web/server.ts:1128`, `src/web/server.ts:1458` |
| `/api/models` | `POST` | Requests a model switch for the selected thread. | Validates `{ thread_id, model_id }` and forwards `intent: "switch_model"`. | `src/web/server.ts:673`, `src/web/server.ts:1160` |
| `/api/capture_interval` | `GET` | Returns the current monitor capture interval used by manual progress refresh. | Sends a global `intent: "capture_interval"` message and parses the numeric reply with a `7000 ms` fallback. | `src/web/server.ts:678`, `src/web/server.ts:1207` |
| `/api/capture_interval` | `POST` | Updates the monitor capture interval. | Validates `{ interval_ms }` in the `2000..30000` range and sends a global `intent: "capture_interval"` message with the requested value. | `src/web/server.ts:683`, `src/web/server.ts:1227` |
| `/api/autoapprove` | `GET` | Returns the current approval-policy state for one thread. | Validates `thread_id`, forwards a global `intent: "list"` query, and extracts `auto_approve` for the matching instance. Returns `404` when the instance is not found. | `src/web/server.ts` (autoApproveQuerySchema), `handleAutoApproveQueryRequest` |
| `/api/autoapprove` | `POST` | Sets the approval-policy state for one thread at runtime. | Validates `{ thread_id, enabled }`, forwards `intent: "set_auto_approve"` with Hub-private string-boolean payload content, and returns `{ thread_id, auto_approve }`. Maps Hub "no registered agent" errors to `404`. | `src/web/server.ts` (autoApproveSetBodySchema), `handleAutoApproveSetRequest` |
| `/api/callers` | `GET` | [ADDED 2026-05-05] Lists all registered callers. Signs as `meridian-admin` using a derived builtin key; gated by `Authorization: Bearer <WEB_GUI_TOKEN>`. Strips `key_hash` defensively at the web layer. Dispatches `intent: "list_callers"`. Returns `{ callers: CallerRecord[] (without key_hash), bootstrap_key_set: boolean }`. | `src/web/server.ts` (`handleListCallersRequest`), `buildAdminSender`, `ADMIN_CALLER_IDENTITY` |
| `/api/callers` | `POST` | [ADDED 2026-05-05] Registers a new external caller. Body `{ caller_id, caller_label }` validated against `/^[a-z][a-z0-9_-]*$/` and 1–64 char label. Gated by `Authorization: Bearer <WEB_GUI_TOKEN>`. Signs as `meridian-admin`. Dispatches `intent: "register_caller"` with `caller_kind: "external"`. Returns `{ caller_id, caller_key }` (cleartext, show-once). Collision returns `409`. | `src/web/server.ts` (`handleRegisterCallerRequest`, `registerCallerBodySchema`) |
| `/api/callers/:id/rotate` | `POST` | [ADDED 2026-05-05] Rotates a caller's key and returns the new cleartext key. Gated by `Authorization: Bearer <WEB_GUI_TOKEN>`. Signs as `meridian-admin`. Built-in callers return `400`. Unknown caller returns `404`. Dispatches `intent: "rotate_caller_key"`. Returns `{ caller_key }` (cleartext, show-once). | `src/web/server.ts` (`handleRotateCallerKeyRequest`), `BUILTIN_CALLER_ID_SET` |
| `/api/callers/:id/authority` | `PATCH` | [ADDED 2026-05-05] Updates an external caller's persisted authority. Body `{ caller_authority: "read" | "write" | "admin" }`. Gated by `Authorization: Bearer <WEB_GUI_TOKEN>`. Signs as `meridian-admin`. Built-in callers return `400`; unknown caller returns `404`. Dispatches `intent: "update_caller_authority"`. | `src/web/server.ts` (`handleUpdateCallerAuthorityRequest`, `callerAuthorityBodySchema`) |
| `/api/callers/:id` | `DELETE` | [ADDED 2026-05-05] Revokes a caller (preserves the slot). Gated by `Authorization: Bearer <WEB_GUI_TOKEN>`. Signs as `meridian-admin`. Built-in callers return `400`. Unknown caller returns `404`. Dispatches `intent: "unregister_caller"`. Returns `{ revoked_at }`. | `src/web/server.ts` (`handleUnregisterCallerRequest`), `BUILTIN_CALLER_ID_SET` |

### WebSocket Bridge

| Path | Auth / Query | Hub Bridge | Browser Event Types | Key refs |
|--------|------|---------|--------|--------------|
| `/ws/terminal` | Requires a valid GUI token plus `thread_id`; accepts optional `replay_lines` (default `200`). | Performs a manual RFC6455 upgrade, opens a Unix-socket hub bridge, sends `{"type":"subscribe_pane_output","thread_id","replay_lines"}` on connect, and sends `{"type":"unsubscribe_pane_output","thread_id"}` during cleanup. | Forwards `pane_output` chunks, structured `a2a_message` task updates, and `not_available` payloads to the browser; browser-to-server traffic is limited to WebSocket control frames such as ping and close. | `src/web/server.ts:1302`, `src/web/server.ts:1382`, `src/web/server.ts:1410`, `src/web/server.ts:1500`, `src/web/public/terminal.html:3217`, `src/web/public/terminal.html:3254` |

### Frontend Pages & Shared Assets

| Path | Purpose | Key DOM IDs / Functions | Surface | Key refs |
|--------|------|---------|--------|--------------|
| `/` and `/index.html` | Hub landing page for spawning sessions, browsing live agents, monitoring log footprint, and managing caller keys. Each agent card shows a "Last caller: …" line and a "Spawned by: …" detail row populated from `inst.last_caller` and `inst.spawned_by`. A collapsible `<details id="caller-admin">` panel lists all registered callers with Rotate/Revoke actions for external callers; a Mint button opens a validated modal that calls `POST /api/callers` and shows the cleartext key exactly once in the key reveal modal. `[UPDATED 2026-05-05]` | Uses `#spawn-provider`, `#btn-spawn`, `#grid`, `#log-list`, `#caller-admin`, `#caller-admin-table`, `#caller-mint`, `#key-reveal-dialog`, `#mint-dialog`, and the `#spawn-workspace-dialog` picker; core flows are `fetchList()`, `spawn()`, `fetchSpawnBrowse()`, `openLogViewer()`, `clearLogFile()`, `doLoadCallers()`, `doMintCaller()`, `doRotateCaller()`, `doRevokeCaller()`, `renderCallerTable()`, `showKeyReveal()`, and `dismissKeyReveal()`. | Calls `/api/instances`, `/api/logs`, `/api/log_file`, `/api/log_file/clear`, `/api/spawn`, `/api/spawn_repos/browse`, `/api/callers` (GET/POST), `/api/callers/:id/rotate` (POST), and `/api/callers/:id` (DELETE); opens `terminal.html` per thread and links to the sibling meridian-roles UI. | `src/web/public/index.html` |
| `/terminal.html` | Primary live session UI with terminal pane, filtered chat view, file explorer/editor, session history, model picker, push toggle, and mobile overflow actions. Every chat bubble (user + agent) renders a `.chat-bubble-meta` strip with caller label and ISO timestamp; agent bubbles inherit the originating user_send caller via a trace_id → caller map built once per `/api/history` load. `[UPDATED 2026-05-05]` | Uses `#term-container`, `#chat-messages`, `#file-tree`, `#editor-content`, `#model-select`, `#capture-interval`, and `#filters-modal`; core flows are `loadXterm()`, `handleA2AMessage()`, `pollThreadProgress()`, `refreshModelCatalog()`, `connectWebSocket()`, `refreshFiles()`, `openFile()`, `handleSend()`, plus `addChatBubble(content, type, detailsText, { caller, timestamp, traceId })` and the `rememberCallerForTrace` / `lookupCallerForTrace` / `formatBubbleTimePretty` helpers added by R-06. | Calls `/ws/terminal`, `/api/history`, `/api/progress/:thread_id`, `/api/files`, `/api/file`, `/api/run`, `/api/terminal_input`, `/api/push`, `/api/models`, `/api/capture_interval`, `/api/reboot`, `/api/kill`, `/api/history_threads`, and `/api/instances`. | `src/web/public/terminal.html:913`, `src/web/public/terminal.html:1072`, `src/web/public/terminal.html:1615`, `src/web/public/terminal.html:2683`, `src/web/public/terminal.html:2867`, `src/web/public/terminal.html:3254`, `src/web/public/terminal.html:3772`, `src/web/public/terminal.html:3802`, `src/web/public/terminal.html:3436` |
| `/bridge.html` | Minimal single-thread bridge page for quick run / kill / reboot control without the full terminal UI. | Uses `#thread-label`, `#latest-result`, `#input-run`, `#btn-run`, `#btn-kill`, and `#btn-reboot`; core flows are `setMeta()`, `runCommand()`, and `threadAction()`. | Calls `/api/instances`, `/api/run`, `/api/kill`, and `/api/reboot`. | `src/web/public/bridge.html:49`, `src/web/public/bridge.html:152`, `src/web/public/bridge.html:162`, `src/web/public/bridge.html:181`, `src/web/public/bridge.html:205` |
| `/app.js` | Shared browser helper namespace for token storage, API base resolution, authenticated fetches, focus-mode persistence, and custom filter persistence. | Exposes `window.MeridianWeb.*` methods used by both HTML clients. | Adds the GUI token to API requests and persists UI preferences in browser storage. | `src/web/public/app.js:13`, `src/web/public/app.js:84`, `src/web/public/app.js:103`, `src/web/public/app.js:124`, `src/web/public/app.js:139` |
| `/layout-base.css` | Shared viewport baseline used by every HTML page. | Applies only a box-sizing reset and full-width / full-height viewport defaults. | No API or WebSocket usage. | `src/web/public/layout-base.css:1` |

## Exports

**src/web/server.ts**

### `WebInterfaceLogger`
- **File**: `src/web/server.ts:157`
- **Purpose**: Defines the minimal logger contract the web server accepts for injected logging.
- **Implementation**: The interface only requires `info`, `warn`, and `error` methods with variadic payload support, which lets tests provide lightweight stubs while production defaults to `createLogger("web")`.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:50:33+09:00]`

### `WebInterfaceServerOptions`
- **File**: `src/web/server.ts:163`
- **Purpose**: Describes the configuration and dependency-injection surface for the web server.
- **Implementation**: The options cover enablement, host/port, auth token, TLS paths, static assets, hub request wiring, socket creation, and logger injection. `WebInterfaceServer` resolves missing values from `config` so callers can override only the pieces they need.
- **Dependencies**: `config`, `types`
- **Status**: `[ADDED 2026-04-08T14:50:33+09:00]`

### `WebInterfaceServer`
- **File**: `src/web/server.ts:428`
- **Purpose**: Hosts the authenticated HTTP API, static asset serving, and terminal-pane WebSocket bridge for the browser UI.
- **Implementation**: The class validates request bodies with Zod, maps API routes to hub intents or guarded filesystem access, creates per-session `actor_id` / reply-channel hub messages, optionally boots HTTPS from configured cert/key files, and maintains WebSocket bridge lifecycles that subscribe and unsubscribe pane output over the hub Unix socket. It also normalizes error text into browser-friendly messages and sets a sticky session cookie when the caller does not provide a session identifier.
- **Dependencies**: `config`, `interface/ipc-sender`, `logger`, `log-retention`, `types`
- **Status**: `[ADDED 2026-04-08T14:50:33+09:00]`

### `startWebInterfaceServer(options): Promise<WebInterfaceServer | null>`
- **File**: `src/web/server.ts:1654`
- **Purpose**: Starts the configured web server and returns the live instance when startup is enabled.
- **Implementation**: The helper constructs `WebInterfaceServer`, calls `start()`, and converts the class-level boolean startup result into either the running server or `null`. The module-level CLI entrypoint below it stores that instance for `SIGINT` / `SIGTERM` shutdown. [UPDATED 2026-05-05] At process boot, before constructing the server, derives the `meridian-web` caller key via `deriveBuiltinCallerKey` (from `shared/caller-bootstrap`) and calls `setCallerIdentity` on the default IPC sender. Throws `bootstrap_key_missing` at boot if `MERIDIAN_INTERNAL_BOOTSTRAP_KEY` is absent.
- **Dependencies**: `config`, `interface/ipc-sender`, `shared/caller-bootstrap`, `logger`, `log-retention`, `types`
- **Status**: `[UPDATED 2026-05-05]`

**src/web/public/app.js**

### `window.MeridianWeb.getQueryParams()`
- **File**: `src/web/public/app.js:13`
- **Purpose**: Parses the current page query string into a plain object for the browser clients.
- **Implementation**: The helper splits `window.location.search`, decodes each `key=value` pair, and returns a map that both HTML clients use to recover `thread_id`, `token`, and optional `session_id` values.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:50:33+09:00]`

### `window.MeridianWeb.getToken()`
- **File**: `src/web/public/app.js:38`
- **Purpose**: Returns the active GUI token for browser API calls.
- **Implementation**: It prefers a `?token=` query value, falls back to the in-memory cache, and then reads `sessionStorage` so pages can survive reloads without manually re-entering the token.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:50:33+09:00]`

### `window.MeridianWeb.setToken(token)`
- **File**: `src/web/public/app.js:53`
- **Purpose**: Updates the in-memory and session-storage copy of the GUI token.
- **Implementation**: The helper trims the incoming token, writes or removes `meridian_web_token` in `sessionStorage`, swallows storage failures, and returns a boolean indicating whether the persisted state matches the requested value.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:50:33+09:00]`

### `window.MeridianWeb.apiBase()`
- **File**: `src/web/public/app.js:75`
- **Purpose**: Computes the base origin/path prefix for root-relative browser API calls.
- **Implementation**: It starts from `window.location.origin`, strips the current filename from the pathname, and preserves subpath hosting instead of assuming the UI always lives at `/`.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:50:33+09:00]`

### `window.MeridianWeb.fetchWithAuth(url, options)`
- **File**: `src/web/public/app.js:84`
- **Purpose**: Wraps `fetch()` so browser pages consistently send the GUI bearer token.
- **Implementation**: The helper normalizes the provided headers object, injects `Authorization: Bearer <token>` when available, and prefixes root-relative paths with `apiBase()` before dispatching the request.
- **Dependencies**: `web/server`
- **Status**: `[ADDED 2026-04-08T14:50:33+09:00]`

### `window.MeridianWeb.ensureToken()`
- **File**: `src/web/public/app.js:98`
- **Purpose**: Provides a quick boolean check for whether the browser currently has a usable GUI token.
- **Implementation**: It delegates to `getToken()` and returns `true` only when a non-empty token is available, letting pages short-circuit into their unauthorized UI states.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:50:33+09:00]`

### `window.MeridianWeb.getFocusModeEnabled(defaultValue)`
- **File**: `src/web/public/app.js:103`
- **Purpose**: Restores the terminal page focus-mode preference from session storage.
- **Implementation**: The helper reads `meridian_focus_mode`, recognizes explicit `on` / `off` values, and falls back to the caller-provided default when storage is unavailable or unset.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:50:33+09:00]`

### `window.MeridianWeb.setFocusModeEnabled(enabled)`
- **File**: `src/web/public/app.js:115`
- **Purpose**: Persists the terminal page focus-mode preference for the current browser session.
- **Implementation**: It writes `on` or `off` into `sessionStorage` and deliberately ignores storage failures so the UI remains usable in constrained browser contexts.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:50:33+09:00]`

### `window.MeridianWeb.getCustomFilters(scope)`
- **File**: `src/web/public/app.js:124`
- **Purpose**: Loads the saved custom filter list for either GUI chat bubbles or interface pushes.
- **Implementation**: The helper reads `localStorage`, parses the JSON payload for the requested scope, and falls back to an empty array when parsing or storage access fails.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:50:33+09:00]`

### `window.MeridianWeb.setCustomFilters(scope, filters)`
- **File**: `src/web/public/app.js:133`
- **Purpose**: Persists a custom filter list for the requested scope.
- **Implementation**: It serializes the filter array into `localStorage` under the scope-prefixed key and ignores storage errors so filter editing does not break the rest of the UI.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:50:33+09:00]`

### `window.MeridianWeb.loadCallers()`
- **File**: `src/web/public/app.js`
- **Purpose**: Fetches the full caller list from the hub admin API.
- **Implementation**: Calls `GET /api/callers` via `fetchWithAuth`, returns a Promise that resolves to the parsed JSON body `{ callers, bootstrap_key_set }` or rejects with the server error message. Callers of this function render the result into `#caller-admin-table`.
- **Dependencies**: `fetchWithAuth`
- **Status**: `[ADDED 2026-05-05]`

### `window.MeridianWeb.mintCaller(callerId, callerLabel)`
- **File**: `src/web/public/app.js`
- **Purpose**: Registers a new external caller and returns its cleartext key for one-time display.
- **Implementation**: Posts `{ caller_id, caller_label }` to `POST /api/callers` via `fetchWithAuth`. Resolves to `{ caller_id, caller_key }` (cleartext, show-once) or rejects with the server error. The caller key must be shown in the key reveal modal and never persisted.
- **Dependencies**: `fetchWithAuth`
- **Status**: `[ADDED 2026-05-05]`

### `window.MeridianWeb.rotateCaller(callerId)`
- **File**: `src/web/public/app.js`
- **Purpose**: Rotates an external caller's key and returns the new cleartext key for one-time display.
- **Implementation**: Posts to `POST /api/callers/:id/rotate` via `fetchWithAuth`. Resolves to `{ caller_key }` (cleartext, show-once) or rejects with the server error. Built-in callers return 400.
- **Dependencies**: `fetchWithAuth`
- **Status**: `[ADDED 2026-05-05]`

### `window.MeridianWeb.revokeCaller(callerId)`
- **File**: `src/web/public/app.js`
- **Purpose**: Revokes an external caller, permanently disabling their key.
- **Implementation**: Sends `DELETE /api/callers/:id` via `fetchWithAuth`. Resolves to `{ revoked_at }` or rejects with the server error. Built-in callers return 400.
- **Dependencies**: `fetchWithAuth`
- **Status**: `[ADDED 2026-05-05]`

## Test Files

- `src/web/server.test.ts`
- `src/web/public-app.test.ts`
- `src/web/public-layout.test.ts`
