/**
 * Canonical catalog of LLM agent kinds supported by meridian-roles.
 *
 * The list mirrors what meridian-hub exposes via `/api/spawn` (MeridianAgentType
 * in agent-dispatcher/meridian-api-client.ts) plus the local "claude-code"
 * routing target used by ChatterRole. Each kind also carries the models the
 * roles GUI is willing to surface for that kind so downstream callers
 * (chatter operators, dispatch wizards, etc.) can choose without re-deriving
 * the list from hub internals.
 *
 * Source of truth for models is intentionally co-located with the kinds; the
 * existing `WORKER_MODEL_OPTIONS` array in app.js stays for legacy callers
 * but the GUI catalog endpoint always sources from this file.
 */

export interface AgentKindEntry {
  readonly kind: string;
  readonly label: string;
  readonly models: ReadonlyArray<string>;
}

const SUPPORTED_AGENT_KINDS: ReadonlyArray<AgentKindEntry> = [
  {
    kind: "claude-code",
    label: "claude-code (local Claude Code CLI)",
    models: [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6"
    ]
  },
  {
    kind: "codex",
    label: "codex",
    models: [
      "gpt-5.5 medium",
      "gpt-5.5 high",
      "gpt-5.5 xhigh",
      "gpt-5.4 medium",
      "gpt-5.4 high",
      "gpt-5.4 xhigh",
      "gpt-5.3-codex",
      "gpt-5.2-codex",
      "codex-5.3-max"
    ]
  },
  {
    kind: "claude",
    label: "claude",
    models: [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6"
    ]
  },
  {
    kind: "gemini",
    label: "gemini",
    models: [
      "gemini-2.5-pro"
    ]
  },
  {
    kind: "cursor",
    label: "cursor",
    models: []
  }
];

export function listAgentKinds(): ReadonlyArray<AgentKindEntry> {
  return SUPPORTED_AGENT_KINDS;
}
