// Meridian Gateway — shared types + helpers for the per-provider modules.
// Each provider (claude/codex/gemini/antigravity) drives its real OAuth-logged-in CLI in
// one-shot mode and returns a normalized CompletionResult. The HTTP layer
// (v1-gateway.ts) shapes that into OpenAI / Anthropic wire formats.

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string | Array<{ type?: string; text?: string }>;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

export type FinishReason = "stop" | "length" | "tool_calls";

export interface CompletionResult {
  text: string;
  model: string; // the actual upstream model that served the request
  finishReason: FinishReason;
  usage: { promptTokens: number; completionTokens: number };
  isError?: boolean;
  errorMessage?: string;
}

/**
 * Strip a leading vendor/provider prefix from a model id.
 *
 * clawso namespaces every provider's models as `<providerId>/<model>` (e.g.
 * `custom-meridian-gateway/gpt-5.5`) for its failover + agent-bridge registry,
 * and may send that namespaced id straight to the endpoint. None of the real
 * upstream model ids we serve usually contain no `/` (claude-opus-4-8,
 * gpt-5.5, gemini-2.5-pro), so any `/` is an outer prefix: keep only the last
 * segment. Antigravity is the exception: it deliberately uses
 * `antigravity/<agy-model>` so Gemini-looking model ids sourced from `agy`
 * still route to Antigravity instead of the legacy gemini CLI.
 * Without this, `custom-meridian-gateway/gpt-5.5` fails every `^gpt`/`^gemini`
 * matcher and silently misroutes to the Claude default.
 */
export function normalizeModel(model: string | undefined): string | undefined {
  if (!model) return model;
  const parts = model.split("/");
  const antigravityIndex = parts.findIndex((part) => part.toLowerCase() === "antigravity");
  if (antigravityIndex >= 0 && antigravityIndex < parts.length - 1) {
    return parts.slice(antigravityIndex).join("/");
  }
  const i = model.lastIndexOf("/");
  return i >= 0 ? model.slice(i + 1) : model;
}

export function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("");
  }
  return "";
}

/** Split messages into a system block + a Human/Assistant transcript prompt. */
export function buildPrompt(messages: ChatMessage[]): { system: string; prompt: string } {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => contentToText(m.content))
    .join("\n\n")
    .trim();
  const prompt = messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "assistant" ? "Assistant" : "Human"}: ${contentToText(m.content)}`)
    .join("\n\n");
  return { system, prompt };
}
