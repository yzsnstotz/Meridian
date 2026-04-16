# agents
**Source**: `src/agents/`
**Summary**: Provider-specific CLI configs and argument builders for spawning or streaming Claude, Codex, Gemini, and Cursor agents through the hub bridge.
**Last Scanned**: 2026-04-16T12:00:00+09:00
**Exports Documented**: 19

## Provider Launch-Policy Ownership

Meridian is the single owner of provider launch-policy mapping. The public HTTP boundary (`src/web/server.ts`) carries only a neutral approval policy field: `auto_approve: boolean` at spawn time on `/api/spawn`, and `enabled: boolean` at runtime on `/api/autoapprove`. The Hub (`src/hub/router.ts`, `src/hub/instance-manager.ts`) threads that flag into the provider-specific builders below, which are the only place raw CLI flags are assembled. External callers — Meridian GUI, Meridian CLI, and Meridian-roles — must never inject provider CLI flags through the API boundary; they must pass only the neutral policy field. This contract is verified by `src/agents/claude.test.ts`, `src/agents/codex.test.ts`, and the boundary assertions in `src/web/server.test.ts`.

- Codex: `autoApprove === true` maps to `--dangerously-bypass-approvals-and-sandbox` (`src/agents/codex.ts:39`, `src/agents/codex.ts:52`, `src/agents/codex.ts:68`).
- Claude: `autoApprove === true` maps to `--dangerously-skip-permissions` (`src/agents/claude.ts:29`, `src/agents/claude.ts:63`).
- Gemini and Cursor do not expose an auto-approve flag; the policy field is ignored at the provider layer.

## Agent Provider Matrix

| Provider | Spawn / Stream Shape | Env Vars | Notes |
|--------|------|---------|--------|
| `claude` | `buildClaudeSpawnArgs()` wraps `server --type=claude`; `buildClaudeCliArgs()` and `buildClaudeStreamArgs()` force `stream-json`, verbose logging, partial messages, and the default allowed-tools allowlist. | `ANTHROPIC_API_KEY` is defined in `src/config.ts:82` and consumed by the provider model catalog in `src/shared/model-catalog.ts:362`. No env var is read directly in `src/agents/claude.ts`. | Streaming is enabled for Claude in `src/hub/instance-manager.ts:1294`. Key refs: `src/agents/claude.ts:19`, `src/agents/claude.ts:42`, `src/agents/claude.ts:56`. |
| `codex` | `buildCodexSpawnArgs()` wraps `server --type=codex`; `buildCodexExecArgs()` and `buildCodexResumeArgs()` run `codex exec --json`, optionally resuming a saved session and injecting reasoning effort via `-c`. | `OPENAI_API_KEY` is defined in `src/config.ts:83` and used only as a model-catalog fallback in `src/shared/model-catalog.ts:153`. No env var is read directly in `src/agents/codex.ts`. | Streaming is enabled for Codex in `src/hub/instance-manager.ts:1294`, and the direct exec/resume helpers support session reuse. Key refs: `src/agents/codex.ts:23`, `src/agents/codex.ts:45`, `src/agents/codex.ts:57`. |
| `gemini` | `buildGeminiSpawnArgs()` wraps `server --type=gemini`; `buildGeminiStreamArgs()` uses direct CLI streaming. Both force `--output-format stream-json`. | `GEMINI_API_KEY` is defined in `src/config.ts:84` and consumed by the provider model catalog in `src/shared/model-catalog.ts:398`. No env var is read directly in `src/agents/gemini.ts`. | Streaming is enabled for Gemini in `src/hub/instance-manager.ts:1294`. Key refs: `src/agents/gemini.ts:16`, `src/agents/gemini.ts:32`. |
| `cursor` | `buildCursorSpawnArgs()` wraps `server --type=cursor` and launches `cursor-agent` with an optional model override. There is no direct stream helper in this module. | `CURSOR_API_KEY` is defined in `src/config.ts:85` and passed through only when `cursor-agent models` runs in `src/shared/model-catalog.ts:435`. No env var is read directly in `src/agents/cursor.ts`. | Cursor is not treated as a streaming provider by `src/hub/instance-manager.ts:1294`. Key refs: `src/agents/cursor.ts:16`, `src/hub/instance-manager.ts:1298`. |

## Exports

**Claude**

### `CLAUDE_AGENT_TYPE`
- **File**: `src/agents/claude.ts:3`
- **Purpose**: Declares the literal provider tag used for Claude agent registrations.
- **Implementation**: This constant anchors the exported config type and the `--type=claude` bridge spawn flag built later in the file.
- **Dependencies**: `None`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `ANTHROPIC_API_KEY` is part of Meridian config for Claude model discovery, but this constant does not read env directly.

### `DEFAULT_CLAUDE_ALLOWED_TOOLS`
- **File**: `src/agents/claude.ts:5`
- **Purpose**: Defines the default Claude tool allowlist used by CLI and streaming invocations.
- **Implementation**: The tuple defaults to `Bash`, `Edit`, and `Replace`, and `claudeAgentConfig` reuses it so callers do not need to supply a tool set for standard runs.
- **Dependencies**: `None`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `ANTHROPIC_API_KEY` is part of Meridian config for Claude model discovery, but this constant does not read env directly.

### `ClaudeAgentConfig`
- **File**: `src/agents/claude.ts:7`
- **Purpose**: Types the exported Claude provider config object.
- **Implementation**: The interface fixes the provider tag, CLI command name, and allowed-tools list shape so downstream code receives a stable config contract.
- **Dependencies**: `None`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `ANTHROPIC_API_KEY` is part of Meridian config for Claude model discovery, but this interface does not read env directly.

### `claudeAgentConfig`
- **File**: `src/agents/claude.ts:13`
- **Purpose**: Publishes the default Claude provider configuration used by the builder helpers.
- **Implementation**: It binds the literal provider tag, the `claude` CLI command, and the default allowed-tools tuple into one reusable config object.
- **Dependencies**: `None`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `ANTHROPIC_API_KEY` is part of Meridian config for Claude model discovery, but this config object does not read env directly.

### `buildClaudeCliArgs(allowedTools: readonly string[] = claudeAgentConfig.allowedTools, modelId?: string, autoApprove?: boolean): string[]`
- **File**: `src/agents/claude.ts:19`
- **Purpose**: Builds the base Claude CLI argument vector for interactive runs.
- **Implementation**: The helper always enables `stream-json`, verbose output, partial messages, and an allowlisted tool set, then appends model and permission-skipping flags when requested.
- **Dependencies**: `None`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `ANTHROPIC_API_KEY` is part of Meridian config for Claude model discovery, but this builder does not read env directly.

### `buildClaudeSpawnArgs(mode: BridgeMode, tmuxSession: string | null, endpointFlag: string, modelId?: string, autoApprove?: boolean): string[]`
- **File**: `src/agents/claude.ts:42`
- **Purpose**: Builds the bridge-side spawn command for a Claude worker process.
- **Implementation**: The function ignores `mode` and `tmuxSession`, prefixes the command with `server --type=claude` plus the caller-supplied socket or endpoint flag, and appends the standard Claude CLI args after `--`.
- **Dependencies**: `types`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `ANTHROPIC_API_KEY` is part of Meridian config for Claude model discovery, but this builder does not read env directly.

### `buildClaudeStreamArgs(modelId?: string, autoApprove?: boolean): string[]`
- **File**: `src/agents/claude.ts:56`
- **Purpose**: Builds a direct Claude CLI invocation for streamed replies.
- **Implementation**: It switches Claude into `--print` mode while preserving `stream-json`, verbose logging, partial-message emission, the default tool allowlist, and the optional model and skip-permissions flags.
- **Dependencies**: `None`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `ANTHROPIC_API_KEY` is part of Meridian config for Claude model discovery, but this builder does not read env directly.

**Codex**

### `CodexAgentConfig`
- **File**: `src/agents/codex.ts:6`
- **Purpose**: Types the exported Codex provider config object.
- **Implementation**: The interface fixes the provider tag and command name so helper functions can expose a narrow, stable config shape.
- **Dependencies**: `None`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `OPENAI_API_KEY` is available only for Codex model-catalog fallback; this interface does not read env directly.

### `codexAgentConfig`
- **File**: `src/agents/codex.ts:11`
- **Purpose**: Publishes the default Codex provider configuration used by command builders.
- **Implementation**: It binds the literal `codex` provider tag and CLI command name into a shared config object for spawn, exec, and resume helpers.
- **Dependencies**: `None`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `OPENAI_API_KEY` is available only for Codex model-catalog fallback; this config object does not read env directly.

### `buildCodexSpawnArgs(mode: BridgeMode, tmuxSession: string | null, endpointFlag: string, modelId?: string, autoApprove?: boolean, reasoningEffort?: ReasoningEffort): string[]`
- **File**: `src/agents/codex.ts:23`
- **Purpose**: Builds the bridge-side spawn command for a Codex worker process.
- **Implementation**: The helper wraps the `codex` CLI behind `server --type=codex`, injects an endpoint flag, optionally adds reasoning-effort config before the model flag, and enables bridge-level auto-approve when requested.
- **Dependencies**: `types`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `OPENAI_API_KEY` is available only for Codex model-catalog fallback; this builder does not read env directly.

### `buildCodexExecArgs(modelId?: string, autoApprove?: boolean, reasoningEffort?: ReasoningEffort): string[]`
- **File**: `src/agents/codex.ts:45`
- **Purpose**: Builds a direct Codex exec command that emits JSON frames.
- **Implementation**: It starts with `codex exec --json`, optionally appends reasoning-effort config and model selection, and uses Codex's sandbox-bypass flag when Meridian enables auto-approve.
- **Dependencies**: `types`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `OPENAI_API_KEY` is available only for Codex model-catalog fallback; this builder does not read env directly.

### `buildCodexResumeArgs(sessionId: string, modelId?: string, autoApprove?: boolean, reasoningEffort?: ReasoningEffort): string[]`
- **File**: `src/agents/codex.ts:57`
- **Purpose**: Builds a Codex exec-resume command for continuing an existing session.
- **Implementation**: The helper prepends `codex exec resume <sessionId> --json`, then reuses the same optional reasoning-effort, model, and sandbox-bypass flags as the direct exec path.
- **Dependencies**: `types`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `OPENAI_API_KEY` is available only for Codex model-catalog fallback; this builder does not read env directly.

**Gemini**

### `GeminiAgentConfig`
- **File**: `src/agents/gemini.ts:6`
- **Purpose**: Types the exported Gemini provider config object.
- **Implementation**: The interface fixes the provider tag and command name shared by the Gemini spawn and stream builders.
- **Dependencies**: `None`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `GEMINI_API_KEY` is part of Meridian config for Gemini model discovery, but this interface does not read env directly.

### `geminiAgentConfig`
- **File**: `src/agents/gemini.ts:11`
- **Purpose**: Publishes the default Gemini provider configuration used by the builder helpers.
- **Implementation**: It binds the literal provider tag and CLI command name into one shared config object used for spawn and direct stream commands.
- **Dependencies**: `None`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `GEMINI_API_KEY` is part of Meridian config for Gemini model discovery, but this config object does not read env directly.

### `buildGeminiSpawnArgs(mode: BridgeMode, tmuxSession: string | null, endpointFlag: string, modelId?: string): string[]`
- **File**: `src/agents/gemini.ts:16`
- **Purpose**: Builds the bridge-side spawn command for a Gemini worker process.
- **Implementation**: The helper ignores `mode` and `tmuxSession`, wraps the CLI with `server --type=gemini`, and always adds `--output-format stream-json` before the optional model flag.
- **Dependencies**: `types`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `GEMINI_API_KEY` is part of Meridian config for Gemini model discovery, but this builder does not read env directly.

### `buildGeminiStreamArgs(modelId?: string): string[]`
- **File**: `src/agents/gemini.ts:32`
- **Purpose**: Builds a direct Gemini CLI invocation for streamed replies.
- **Implementation**: It emits a compact command that always requests `stream-json` output and conditionally pins the provider model.
- **Dependencies**: `None`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `GEMINI_API_KEY` is part of Meridian config for Gemini model discovery, but this builder does not read env directly.

**Cursor**

### `CursorAgentConfig`
- **File**: `src/agents/cursor.ts:6`
- **Purpose**: Types the exported Cursor provider config object.
- **Implementation**: The interface fixes the provider tag and CLI command name used by the Cursor spawn helper.
- **Dependencies**: `None`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `CURSOR_API_KEY` is part of Meridian config for Cursor model discovery, but this interface does not read env directly.

### `cursorAgentConfig`
- **File**: `src/agents/cursor.ts:11`
- **Purpose**: Publishes the default Cursor provider configuration used by the spawn helper.
- **Implementation**: It binds the literal `cursor` provider tag and the `cursor-agent` binary name into a shared config object.
- **Dependencies**: `None`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `CURSOR_API_KEY` is part of Meridian config for Cursor model discovery, but this config object does not read env directly.

### `buildCursorSpawnArgs(mode: BridgeMode, tmuxSession: string | null, endpointFlag: string, modelId?: string): string[]`
- **File**: `src/agents/cursor.ts:16`
- **Purpose**: Builds the bridge-side spawn command for a Cursor worker process.
- **Implementation**: The helper ignores `mode` and `tmuxSession`, prefixes the command with `server --type=cursor`, launches `cursor-agent`, and appends an optional model selection flag.
- **Dependencies**: `types`
- **Status**: `[ADDED 2026-04-08T14:37:36+09:00]`
- **Env Vars**: `CURSOR_API_KEY` is part of Meridian config for Cursor model discovery, but this builder does not read env directly.

## Test Files

- `src/agents/claude.test.ts`
- `src/agents/codex.test.ts`
- `src/agents/gemini.test.ts`
