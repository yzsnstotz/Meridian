# shared
**Source**: `src/shared/`
**Summary**: Shared transport adapters, stream parsers, approval and output normalization, provider model discovery, and Telegram/UI helpers reused by the hub, interface, and agent lifecycle layers.
**Last Scanned**: `2026-04-08T14:28:58+09:00`
**Exports Documented**: 64

## Stream Parser Registry

`src/shared/stream-adapter.ts` is the bridge from raw spawn stdout to normalized `OutputDelta` objects. It feeds `stdout` through `splitNdjsonStream()` and then through a provider-specific parser factory from `src/shared/stream-parsers/`.

| Parser | File | Input Format | Output Format | Key Logic |
|--------|------|--------------|---------------|-----------|
| `claude` | `src/shared/stream-parsers/claude.ts` | Claude NDJSON events with `type`, `session_id`, assistant `message.content[]`, and `result` frames | `OutputDelta` working text for assistant messages; final `result` or `error` on `type === "result"` | Concatenates assistant text blocks, ignores metadata/rate-limit frames, and can reuse the `session_id` captured from earlier init events. |
| `codex` | `src/shared/stream-parsers/codex.ts` | Codex JSONL/NDJSON thread lifecycle events such as `thread.started`, `item.started`, `item.completed`, and `turn.completed` | `OutputDelta` tool-call/tool-result data, assistant text deltas, and a final usage-bearing result | Caches `thread_id` from `thread.started`, ignores non-user-visible lifecycle frames, and extracts command/output payloads from multiple possible item shapes. |
| `gemini` | `src/shared/stream-parsers/gemini.ts` | Gemini CLI NDJSON `init`, `message`, and `result` events keyed by `session_id` | `OutputDelta` working text for assistant messages and final `result` or `error` without extra data shaping | Accepts only assistant `message` frames with flat string content, treats non-success `result` statuses as errors, and backfills `session_id` onto later frames when needed. |
| `ndjson` | `src/shared/stream-parsers/ndjson.ts` | Raw `AsyncIterable<Buffer | string>` chunks from subprocess stdout or fixtures | Parsed JSON objects yielded one line at a time | Buffers across chunk boundaries, skips empty or malformed lines with a warning, and still parses a trailing line when the stream ends without a newline. |

## Exports

**IPC & Communication**

**src/shared/agentapi-client.ts**

### `AgentStatus`
- **File**: `src/shared/agentapi-client.ts:11`
- **Purpose**: Describes the minimal status payload returned by agentapi `/status`.
- **Implementation**: The interface requires a `status` string, optionally carries `thread_id`, and leaves the rest of the payload open so provider-specific status metadata can pass through untouched.
- **Dependencies**: `logger`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `AgentEvent`
- **File**: `src/shared/agentapi-client.ts:17`
- **Purpose**: Normalizes one SSE event emitted by agentapi into the shape Meridian consumers expect.
- **Implementation**: Each event carries the SSE `type`, the client-bound `thread_id`, parsed `data`, and the original raw payload string so downstream code can inspect either representation.
- **Dependencies**: `logger`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `AgentMessageResponse`
- **File**: `src/shared/agentapi-client.ts:24`
- **Purpose**: Provides a permissive JSON-object type for `/message` responses from agentapi.
- **Implementation**: The alias intentionally does not constrain response fields, because providers return heterogeneous payloads and the client only requires the response to be an object.
- **Dependencies**: `logger`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `AgentConversationMessage`
- **File**: `src/shared/agentapi-client.ts:25`
- **Purpose**: Represents one object entry from the agentapi `/messages` conversation history response.
- **Implementation**: Like `AgentMessageResponse`, this stays as `Record<string, unknown>` so the client can validate array/object shape without freezing provider-specific message schemas.
- **Dependencies**: `logger`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `AgentEventSubscription`
- **File**: `src/shared/agentapi-client.ts:27`
- **Purpose**: Defines the disposable handle returned by `subscribeEvents()`.
- **Implementation**: The interface is intentionally just `close()`, which lets callers stop SSE delivery without reaching into the client’s internal socket or timer state.
- **Dependencies**: `logger`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `EventSourceLike`
- **File**: `src/shared/agentapi-client.ts:31`
- **Purpose**: Abstracts the subset of EventSource behavior that `AgentAPIClient` needs for streaming.
- **Implementation**: It captures only `addEventListener()` and `close()`, which is enough for the real `eventsource` package plus injected test doubles.
- **Dependencies**: `logger`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `EventSourceFactory`
- **File**: `src/shared/agentapi-client.ts:40`
- **Purpose**: Types the injectable factory that builds SSE clients for agentapi event streams.
- **Implementation**: The factory receives the target URL and optional fetch override so the client can support both ordinary HTTP endpoints and Unix-socket-backed SSE transport.
- **Dependencies**: `logger`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `SseReconnectAttemptContext`
- **File**: `src/shared/agentapi-client.ts:49`
- **Purpose**: Describes a scheduled SSE reconnect attempt for monitoring hooks.
- **Implementation**: It records the thread, socket/endpoint label, attempt number, backoff delay, and summarized error that caused the disconnect.
- **Dependencies**: `logger`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `SseReconnectExhaustedContext`
- **File**: `src/shared/agentapi-client.ts:57`
- **Purpose**: Describes the terminal state when SSE reconnection retries are exhausted.
- **Implementation**: The callback payload reports the thread, endpoint, total attempts, and final error summary so monitors can surface a durable failure instead of another retry.
- **Dependencies**: `logger`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `AgentAPIClientOptions`
- **File**: `src/shared/agentapi-client.ts:64`
- **Purpose**: Configures thread identity, reconnect policy, logging, and SSE construction for `AgentAPIClient`.
- **Implementation**: Callers can override reconnect counts and delays, inject an `EventSource` factory or logger, and receive reconnect attempt or exhaustion callbacks for external monitoring.
- **Dependencies**: `logger`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `AgentAPIClient`
- **File**: `src/shared/agentapi-client.ts:100`
- **Purpose**: Wraps agentapi HTTP and SSE access over either Unix sockets or ordinary HTTP endpoints.
- **Implementation**: The class validates connectivity with `/status`, sends `/message` and `/messages` requests, rewrites attachments into a transport notice, and manages SSE subscriptions with exponential backoff plus callback hooks. It also contains the Unix-socket request/fetch adapters used both for JSON RPC-style calls and EventSource-compatible streaming.
- **Dependencies**: `logger`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

**src/shared/ipc.ts**

### `sendIpcMessage<T extends object>(socketPath: string, payload: T): Promise<void>`
- **File**: `src/shared/ipc.ts:7`
- **Purpose**: Sends a one-way JSON payload to a Unix-domain IPC socket.
- **Implementation**: It opens a socket connection with a short connect timeout, serializes the payload on `connect`, and resolves once the write is handed off. Connection failures and serialization errors reject the promise immediately.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `sendIpcRequest<TPayload extends object, TResponse>(socketPath: string, payload: TPayload): Promise<TResponse>`
- **File**: `src/shared/ipc.ts:47`
- **Purpose**: Performs a request-response JSON exchange over a Unix-domain IPC socket.
- **Implementation**: It writes the serialized request, buffers the UTF-8 response body until socket close, enforces a longer timeout for slow providers such as `pane_bridge`, and rejects on empty or malformed JSON responses.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `readIpcMessage<T>(raw: string): T`
- **File**: `src/shared/ipc.ts:89`
- **Purpose**: Deserializes a raw IPC message payload into a typed object.
- **Implementation**: The helper is intentionally thin and simply delegates to `JSON.parse`, leaving schema validation to callers that know the expected message shape.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

**src/shared/telegram-controls.ts**

### `HUB_ACTION_CALLBACK_PREFIX`
- **File**: `src/shared/telegram-controls.ts:4`
- **Purpose**: Defines the stable callback-data prefix for Telegram hub action buttons.
- **Implementation**: The rest of the file uses this constant to construct and recognize `reboot` and `kill` callback payloads without duplicating the prefix string.
- **Dependencies**: `config`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `HubActionCallbackIntent`
- **File**: `src/shared/telegram-controls.ts:6`
- **Purpose**: Restricts Telegram hub action callbacks to the supported intents.
- **Implementation**: The type is the two-value union `"reboot" | "kill"`, which keeps callback building and parsing aligned with the only actions the interface currently exposes.
- **Dependencies**: `config`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `buildHubActionCallbackData(intent: HubActionCallbackIntent, threadId: string): string`
- **File**: `src/shared/telegram-controls.ts:8`
- **Purpose**: Encodes a thread-scoped reboot or kill action into Telegram callback data.
- **Implementation**: It joins the prefix, intent, and thread ID with `:` separators so the resulting payload can be round-tripped by `parseHubActionCallbackData()`.
- **Dependencies**: `config`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `parseHubActionCallbackData(data: string): { intent: HubActionCallbackIntent; threadId: string } | null`
- **File**: `src/shared/telegram-controls.ts:12`
- **Purpose**: Validates and decodes Telegram callback data for hub action buttons.
- **Implementation**: The parser checks the prefix, ensures the intent is one of the allowed values, rejoins the rest of the payload into a non-empty thread ID, and returns `null` for any malformed input.
- **Dependencies**: `config`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `buildWebGuiUrl(threadId: string, hostPortOverride?: string): string`
- **File**: `src/shared/telegram-controls.ts:29`
- **Purpose**: Builds the authenticated Meridian web GUI URL for a thread.
- **Implementation**: It derives protocol, host, and default port from config unless a host override is provided, appends `thread_id`, and carries the GUI token query parameter when configured.
- **Dependencies**: `config`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `tryBuildGuiInlineKeyboard(threadId: string, hostPortOverride?: string): TelegramInlineKeyboard | undefined`
- **File**: `src/shared/telegram-controls.ts:53`
- **Purpose**: Produces a Telegram inline keyboard button that opens the web GUI when GUI config is valid.
- **Implementation**: The helper wraps `buildWebGuiUrl()` in a `try/catch` and returns `undefined` instead of throwing when GUI settings are incomplete, which keeps result rendering resilient.
- **Dependencies**: `config`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `buildAgentErrorInlineKeyboard(threadId: string): TelegramInlineKeyboard`
- **File**: `src/shared/telegram-controls.ts:66`
- **Purpose**: Builds the Telegram button row shown when an agent run fails and the user can recover inline.
- **Implementation**: It returns a two-button keyboard whose callback payloads route back through `buildHubActionCallbackData()` for reboot and kill actions.
- **Dependencies**: `config`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

**Streaming & Parsing**

**src/shared/a2a-adapter.ts**

### `A2A_TASK_STATES`
- **File**: `src/shared/a2a-adapter.ts:4`
- **Purpose**: Lists the three A2A task states Meridian emits.
- **Implementation**: The tuple literal defines `"working"`, `"completed"`, and `"failed"`, which are reused to derive the exported `A2ATaskState` union and keep conversions type-safe.
- **Dependencies**: `shared/stream-adapter`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `A2ATaskState`
- **File**: `src/shared/a2a-adapter.ts:5`
- **Purpose**: Constrains A2A task-state values to the literals Meridian supports.
- **Implementation**: The type is derived directly from `A2A_TASK_STATES`, so callers cannot drift away from the concrete state strings used by adapter code.
- **Dependencies**: `shared/stream-adapter`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `A2APart`
- **File**: `src/shared/a2a-adapter.ts:7`
- **Purpose**: Describes one text or structured-data part inside an A2A message.
- **Implementation**: The union matches Meridian’s two outbound payload modes: plain text snippets and arbitrary JSON data such as tool-call metadata.
- **Dependencies**: `shared/stream-adapter`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `A2AMessage`
- **File**: `src/shared/a2a-adapter.ts:9`
- **Purpose**: Defines the A2A envelope produced from streaming deltas and hub results.
- **Implementation**: The shape ties a task ID and task state to a sequence of `A2APart` values, with optional `agentId` support for callers that want to stamp provider identity.
- **Dependencies**: `shared/stream-adapter`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `A2AAdapterLike`
- **File**: `src/shared/a2a-adapter.ts:16`
- **Purpose**: Defines the conversion methods a compatible A2A adapter must implement.
- **Implementation**: `OutputBus` and related callers can depend on this small interface instead of the concrete `A2AAdapter` class, which keeps test doubles trivial.
- **Dependencies**: `shared/stream-adapter`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `outputDeltaToA2A(delta: OutputDelta): A2AMessage`
- **File**: `src/shared/a2a-adapter.ts:32`
- **Purpose**: Converts one normalized stream delta into the A2A message shape.
- **Implementation**: It copies the trace ID into `taskId`, maps the stream phase to an A2A task state, and emits text or data parts only when those fields are present on the input delta.
- **Dependencies**: `shared/stream-adapter`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `hubResultStatusToTaskState(status: HubResultStatus): A2ATaskState`
- **File**: `src/shared/a2a-adapter.ts:49`
- **Purpose**: Maps hub-level result statuses into the coarser A2A task-state vocabulary.
- **Implementation**: `partial` becomes `"working"`, `success` becomes `"completed"`, and both `error` and `timeout` collapse to `"failed"`.
- **Dependencies**: `shared/stream-adapter`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `A2AAdapter`
- **File**: `src/shared/a2a-adapter.ts:61`
- **Purpose**: Provides an object-oriented wrapper over the A2A conversion helpers.
- **Implementation**: The class just delegates its two public methods to `outputDeltaToA2A()` and `hubResultStatusToTaskState()`, which makes it easy to inject as a dependency where a class instance is expected.
- **Dependencies**: `shared/stream-adapter`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `DefaultA2AAdapter`
- **File**: `src/shared/a2a-adapter.ts:71`
- **Purpose**: Re-exports `A2AAdapter` under the conventional default-adapter symbol name.
- **Implementation**: This alias avoids a separate subclass and lets callers import a stable default implementation token while the actual behavior remains in `A2AAdapter`.
- **Dependencies**: `shared/stream-adapter`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

**src/shared/diff-engine.ts**

### `DiffEngine`
- **File**: `src/shared/diff-engine.ts:1`
- **Purpose**: Turns repeated full-text snapshots into append-only deltas keyed by trace ID.
- **Implementation**: `diff()` returns the appended suffix when the new snapshot extends the previous one, but falls back to returning the whole snapshot after discontinuities such as agent restarts. `clear()` removes per-trace state when a stream is finished.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

**src/shared/stream-adapter.ts**

### `OUTPUT_PHASES`
- **File**: `src/shared/stream-adapter.ts:3`
- **Purpose**: Defines the normalized stream phases used across parser and output fanout code.
- **Implementation**: The tuple literal locks the shared phase vocabulary to `"working"`, `"result"`, and `"error"` and acts as the source for the exported phase unions.
- **Dependencies**: `shared/stream-parsers/ndjson`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `OutputDeltaPhase`
- **File**: `src/shared/stream-adapter.ts:4`
- **Purpose**: Restricts the `phase` field on normalized streaming deltas.
- **Implementation**: The type is derived from `OUTPUT_PHASES`, so parser implementations and consumers share one canonical set of allowed phase strings.
- **Dependencies**: `shared/stream-parsers/ndjson`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `OutputPhase`
- **File**: `src/shared/stream-adapter.ts:5`
- **Purpose**: Preserves a shorter alias for the output phase union.
- **Implementation**: It is currently just an alias of `OutputDeltaPhase`, which lets older callers or other type surfaces refer to the phase union without changing behavior.
- **Dependencies**: `shared/stream-parsers/ndjson`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `OutputDelta`
- **File**: `src/shared/stream-adapter.ts:7`
- **Purpose**: Defines the canonical normalized unit of provider streaming output in Meridian.
- **Implementation**: Each delta carries a trace ID, optional span ID, phase, optional text or data payload, and a `final` flag so downstream delivery code can treat all providers uniformly.
- **Dependencies**: `shared/stream-parsers/ndjson`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `StreamAdapter`
- **File**: `src/shared/stream-adapter.ts:16`
- **Purpose**: Describes the interface for provider adapters that can stream normalized output.
- **Implementation**: The contract exposes a `supportsStream` capability flag plus a `stream(sessionId)` async iterable that yields `OutputDelta` values.
- **Dependencies**: `shared/stream-parsers/ndjson`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `streamFromSpawn(stdout: AsyncIterable<Buffer | string>, parser: (event: unknown) => OutputDelta | null): AsyncIterable<OutputDelta>`
- **File**: `src/shared/stream-adapter.ts:21`
- **Purpose**: Converts raw subprocess stdout into normalized stream deltas using a provider parser.
- **Implementation**: The generator splits NDJSON, applies the supplied parser, remembers the latest usable trace ID, and emits a synthetic recoverable error delta if the stream or parser throws before completion.
- **Dependencies**: `shared/stream-parsers/ndjson`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

**src/shared/stream-parsers/claude.ts**

### `parseClaudeEvent(event: unknown): OutputDelta | null`
- **File**: `src/shared/stream-parsers/claude.ts:25`
- **Purpose**: Maps Claude CLI stream events into Meridian `OutputDelta` records.
- **Implementation**: It emits working text only for assistant message blocks with textual content and converts `result` frames into final `result` or `error` deltas. Metadata-only, rate-limit, or textless assistant frames are ignored.
- **Dependencies**: `shared/stream-adapter`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `createClaudeStreamParser(): (event: unknown) => OutputDelta | null`
- **File**: `src/shared/stream-parsers/claude.ts:64`
- **Purpose**: Creates a Claude parser that can retain `session_id` across sparse event payloads.
- **Implementation**: The returned closure remembers the most recent session ID and backfills it onto later records that omit it before delegating to `parseClaudeEvent()`.
- **Dependencies**: `shared/stream-adapter`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

**src/shared/stream-parsers/codex.ts**

### `extractThreadId(event: unknown): string | null`
- **File**: `src/shared/stream-parsers/codex.ts:75`
- **Purpose**: Pulls the thread ID out of the Codex `thread.started` lifecycle event.
- **Implementation**: It returns the `thread_id` only for the start event that establishes stream identity and rejects every other event type with `null`.
- **Dependencies**: `shared/stream-adapter`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `parseCodexEvent(event: unknown): OutputDelta | null`
- **File**: `src/shared/stream-parsers/codex.ts:84`
- **Purpose**: Converts Codex event-stream frames into normalized tool, text, and completion deltas.
- **Implementation**: It ignores non-user-visible lifecycle events, emits in-progress tool-call/tool-result data for command execution items, emits assistant text for completed agent messages, and turns `turn.completed` into the final `result` delta with usage data.
- **Dependencies**: `shared/stream-adapter`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `createCodexStreamParser(): (event: unknown) => OutputDelta | null`
- **File**: `src/shared/stream-parsers/codex.ts:159`
- **Purpose**: Creates a Codex parser that can recover missing `thread_id` values on later events.
- **Implementation**: The closure caches the thread ID from `extractThreadId()` and injects it into subsequent event records that omit the field before passing them to `parseCodexEvent()`.
- **Dependencies**: `shared/stream-adapter`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

**src/shared/stream-parsers/gemini.ts**

### `parseGeminiEvent(event: unknown): OutputDelta | null`
- **File**: `src/shared/stream-parsers/gemini.ts:13`
- **Purpose**: Converts Gemini CLI NDJSON events into Meridian stream deltas.
- **Implementation**: It accepts assistant `message` frames with flat string content as working text, treats `result` frames as final success or error markers based on status, and ignores init, user, or incomplete records.
- **Dependencies**: `shared/stream-adapter`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `createGeminiStreamParser(): (event: unknown) => OutputDelta | null`
- **File**: `src/shared/stream-parsers/gemini.ts:55`
- **Purpose**: Creates a Gemini parser that can preserve `session_id` across follow-up frames.
- **Implementation**: The returned function remembers the last seen `session_id`, patches it into later events that omit it, and then reuses `parseGeminiEvent()` for the actual mapping.
- **Dependencies**: `shared/stream-adapter`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

**src/shared/stream-parsers/ndjson.ts**

### `parseNdjsonLine(line: string): unknown`
- **File**: `src/shared/stream-parsers/ndjson.ts:5`
- **Purpose**: Parses a single NDJSON line into a JSON value when possible.
- **Implementation**: Blank lines return `undefined`, valid JSON is returned as-is, and malformed lines are skipped after a warning that includes the error summary and a short sample.
- **Dependencies**: `logger`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `splitNdjsonStream(stream: AsyncIterable<Buffer | string>): AsyncIterable<unknown>`
- **File**: `src/shared/stream-parsers/ndjson.ts:25`
- **Purpose**: Splits a chunked byte or string stream into parsed NDJSON records.
- **Implementation**: It incrementally decodes buffers, buffers partial lines across chunk boundaries, strips trailing carriage returns, yields only successfully parsed lines, and flushes the last unterminated line when the source completes.
- **Dependencies**: `logger`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

**Business Logic**

**src/shared/agent-output.ts**

### `AgentOutputKind`
- **File**: `src/shared/agent-output.ts:4`
- **Purpose**: Classifies normalized agent output into durable messages, approval prompts, or transient noise.
- **Implementation**: The union is the public vocabulary used by `classifyAgentOutput()` so downstream code can branch on a small stable set of output categories.
- **Dependencies**: `shared/approval`, `shared/terminal-text`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `ClassifiedAgentOutput`
- **File**: `src/shared/agent-output.ts:6`
- **Purpose**: Carries the output category and normalized text returned by `classifyAgentOutput()`.
- **Implementation**: The interface packages the computed `kind` together with the cleaned text that callers can display or inspect without re-running normalization.
- **Dependencies**: `shared/approval`, `shared/terminal-text`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `classifyAgentOutput(content: string): ClassifiedAgentOutput`
- **File**: `src/shared/agent-output.ts:119`
- **Purpose**: Converts raw provider terminal output into a user-visible message classification.
- **Implementation**: It first detects approval prompts via `parseApprovalSummaryFromRawContent()`, then screens out transient status/protocol noise using substring and line-pattern heuristics, and finally returns normalized visible text as an ordinary message when the content is durable.
- **Dependencies**: `shared/approval`, `shared/terminal-text`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

**src/shared/approval.ts**

### `APPROVAL_HELP_TEXT`
- **File**: `src/shared/approval.ts:3`
- **Purpose**: Defines the canonical short help text for supported approval inputs.
- **Implementation**: The string centralizes the accepted action words, aliases, and numeric-option guidance so interface and output formatting can stay consistent.
- **Dependencies**: `shared/terminal-text`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `ApprovalAction`
- **File**: `src/shared/approval.ts:6`
- **Purpose**: Restricts approval decisions to Meridian’s normalized action vocabulary.
- **Implementation**: The union covers `"run"`, `"allow"`, `"all"`, and `"skip"`, which the rest of the parser maps from provider-specific labels and shortcuts.
- **Dependencies**: `shared/terminal-text`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `ApprovalOption`
- **File**: `src/shared/approval.ts:8`
- **Purpose**: Represents one numbered approval option parsed from provider output.
- **Implementation**: Each option records the option key, a display label, and the best-effort normalized `ApprovalAction` when the label can be matched to Meridian’s vocabulary.
- **Dependencies**: `shared/terminal-text`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `normalizeApprovalAction(raw: string): ApprovalAction | null`
- **File**: `src/shared/approval.ts:43`
- **Purpose**: Maps free-form user input and shortcuts onto a canonical approval action.
- **Implementation**: It lowercases and strips separators from the input, then recognizes aliases such as `y`, `tab`, `btab`, `n`, and longer provider-specific spellings for the four supported actions.
- **Dependencies**: `shared/terminal-text`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `normalizeApprovalSelection(raw: string): string | null`
- **File**: `src/shared/approval.ts:65`
- **Purpose**: Normalizes approval input into either a canonical action or a numeric option string.
- **Implementation**: It first reuses `normalizeApprovalAction()` and then falls back to accepting purely numeric inputs so Telegram or terminal replies can select an exact numbered option.
- **Dependencies**: `shared/terminal-text`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `approvalActionToTmuxKeys(action: ApprovalAction): string[]`
- **File**: `src/shared/approval.ts:79`
- **Purpose**: Converts a normalized approval action into the tmux keystrokes needed by `pane_bridge` sessions.
- **Implementation**: It maps actions to the specific numeric selections or `BTab` sequence expected by the interactive approval UI rather than returning semantic labels.
- **Dependencies**: `shared/terminal-text`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `isApprovalPrompt(content: string): boolean`
- **File**: `src/shared/approval.ts:318`
- **Purpose**: Detects whether raw agent output represents an actionable approval prompt.
- **Implementation**: It checks for already-normalized waiting-for-approval text and also re-parses raw Gemini or Codex approval output so callers can identify prompts before any message transformation.
- **Dependencies**: `shared/terminal-text`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `parseApprovalSummaryFromRawContent(content: string): string | null`
- **File**: `src/shared/approval.ts:337`
- **Purpose**: Produces Meridian’s canonical approval summary text from raw provider output.
- **Implementation**: The function delegates to the internal Gemini and Codex prompt parsers and returns the assembled summary string when a supported approval layout is recognized.
- **Dependencies**: `shared/terminal-text`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `selectApprovalOptionInput(content: string, requestedAction: ApprovalAction): string | null`
- **File**: `src/shared/approval.ts:341`
- **Purpose**: Chooses the numeric option key that best matches a requested normalized approval action.
- **Implementation**: It parses the raw prompt into options and then searches for the preferred action, with fallback ordering that prefers broader grants when requesting `allow` or `all`.
- **Dependencies**: `shared/terminal-text`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `buildTelegramApprovalHint(threadId: string): string`
- **File**: `src/shared/approval.ts:369`
- **Purpose**: Generates the Telegram-specific help block appended to approval prompts.
- **Implementation**: It renders ready-to-send `/approve` commands for each supported action, includes a numeric-option example, and reminds users that this flow requires `pane_bridge` mode.
- **Dependencies**: `shared/terminal-text`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

**src/shared/model-catalog.ts**

### `ProviderModelCatalogResult`
- **File**: `src/shared/model-catalog.ts:28`
- **Purpose**: Packages a provider ID with the list of selectable models Meridian discovered for it.
- **Implementation**: `ProviderModelCatalog.listModels()` returns this shape so higher layers can preserve which provider produced the model list alongside the normalized `ProviderModel[]`.
- **Dependencies**: `config`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `ProviderModelCatalogOptions`
- **File**: `src/shared/model-catalog.ts:33`
- **Purpose**: Configures the network, CLI, and credential dependencies used for model discovery.
- **Implementation**: Callers can inject fetch, `execFile`, and file-read helpers plus override API keys and the Codex cache path to make catalog lookup testable and environment-aware.
- **Dependencies**: `config`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `ProviderModelCatalog`
- **File**: `src/shared/model-catalog.ts:99`
- **Purpose**: Resolves the list of available models for Codex, Claude, Gemini, and Cursor.
- **Implementation**: The class chooses a provider-specific discovery path, then normalizes labels and deduplicates results before returning them. Codex is the richest path: it tries the Codex app-server first, falls back to the local models cache, and only then falls back to the OpenAI models API when credentials exist; Anthropic and Gemini use their HTTP model endpoints, while Cursor shells out to `cursor-agent models`.
- **Dependencies**: `config`, `types`
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

**Utilities**

**src/shared/terminal-text.ts**

### `stripAnsiAndControl(content: string): string`
- **File**: `src/shared/terminal-text.ts:8`
- **Purpose**: Removes ANSI escape sequences and carriage returns from raw terminal text.
- **Implementation**: The helper uses a single escape-pattern regex, leaving visible characters and newlines intact so later normalization steps can operate on clean text.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

### `normalizeVisibleText(content: string): string`
- **File**: `src/shared/terminal-text.ts:31`
- **Purpose**: Collapses framed terminal output into the user-visible text Meridian wants to interpret.
- **Implementation**: It first strips ANSI/control characters, then removes box-drawing borders, unwraps boxed content lines, trims leading and trailing blank lines, and returns a clean multiline string.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:28:58+09:00]`

## Test Files

- `src/shared/a2a-adapter.test.ts`
- `src/shared/agent-output.test.ts`
- `src/shared/agentapi-client.test.ts`
- `src/shared/approval.test.ts`
- `src/shared/diff-engine.test.ts`
- `src/shared/ipc.test.ts`
- `src/shared/model-catalog.test.ts`
- `src/shared/stream-adapter.test.ts`
- `src/shared/stream-parsers/claude.test.ts`
- `src/shared/stream-parsers/codex.test.ts`
- `src/shared/stream-parsers/gemini.test.ts`
- `src/shared/stream-parsers/ndjson.test.ts`
