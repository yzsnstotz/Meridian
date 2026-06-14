// Meridian Gateway — shared types + helpers for the per-provider modules.
// Each provider (claude/codex/gemini) drives its real OAuth-logged-in CLI in
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
