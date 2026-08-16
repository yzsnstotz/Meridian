// Meridian Gateway — provider routing by model id.
//
// Extracted so the HTTP layer (v1-gateway.ts) and the streaming / Anthropic
// adapters can all resolve a model id to its backing CLI completion through one
// shared matcher chain, instead of duplicating the if/else.
import { completeClaude, matchesClaude } from "./claude";
import { completeCodex, matchesCodex } from "./codex";
import { completeGemini, matchesGemini } from "./gemini";
import { completeAntigravity, matchesAntigravity } from "./antigravity";
import type { ChatCompletionRequest, CompletionResult } from "./shared";

export type ProviderName = "claude" | "codex" | "gemini" | "antigravity";

/** Resolve a model id to its backing provider (default + all claude* → claude). */
export function providerForModel(model: string | undefined): ProviderName {
  if (matchesAntigravity(model)) return "antigravity";
  if (matchesCodex(model)) return "codex";
  if (matchesGemini(model)) return "gemini";
  return "claude"; // default + all claude*
}

/** Run a non-streaming completion against the provider that owns `req.model`. */
export function complete(req: ChatCompletionRequest): Promise<CompletionResult> {
  if (matchesAntigravity(req.model)) return completeAntigravity(req);
  if (matchesCodex(req.model)) return completeCodex(req);
  if (matchesGemini(req.model)) return completeGemini(req);
  return completeClaude(req); // default + all claude*
}

// Re-export the matchers so callers can import the whole routing surface here.
export { matchesClaude, matchesCodex, matchesGemini, matchesAntigravity };
