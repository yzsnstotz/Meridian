import { completeClaude } from "./claude";
import { completeCodex } from "./codex";
import { completeGemini } from "./gemini";
import type { ProviderId } from "./login";
import type { ChatCompletionRequest, CompletionResult } from "./shared";

export interface GatewayDirectTestBody {
  prompt?: unknown;
  model?: unknown;
}

export interface GatewayDirectTestResult {
  ok: boolean;
  provider: ProviderId;
  model?: string;
  text?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: string;
}

export interface GatewayDirectTestCompletions {
  claude: (req: ChatCompletionRequest) => Promise<CompletionResult>;
  codex: (req: ChatCompletionRequest) => Promise<CompletionResult>;
  gemini: (req: ChatCompletionRequest) => Promise<CompletionResult>;
}

const DEFAULT_COMPLETIONS: GatewayDirectTestCompletions = {
  claude: completeClaude,
  codex: completeCodex,
  gemini: completeGemini
};

function selectedClaudeModelFromError(message: string, fallback?: string): string | undefined {
  const match = /selected model \(([^)]+)\)/i.exec(message);
  return match?.[1] ?? fallback;
}

function normalizeDirectTestError(provider: ProviderId, message: string, model?: string): string {
  if (provider === "gemini" && /IneligibleTierError|UNSUPPORTED_CLIENT|migrate to the Antigravity/i.test(message)) {
    return "Gemini CLI reports this account or tier is no longer supported by the Gemini CLI client. " +
      "Use Update CLI from the provider card if an update is available; if it still fails, migrate this account to Antigravity: https://antigravity.google.";
  }
  if (
    provider === "claude" &&
    /api_error_status"?\s*:?\s*404|selected model|may not exist or you may not have access/i.test(message)
  ) {
    const rejectedModel = selectedClaudeModelFromError(message, model);
    return `Claude rejected the selected model${rejectedModel ? ` (${rejectedModel})` : ""}. ` +
      "Choose Provider default or another model from the refreshed list.";
  }
  return message;
}

export async function runGatewayDirectTest(
  provider: ProviderId,
  body: GatewayDirectTestBody,
  completions: GatewayDirectTestCompletions = DEFAULT_COMPLETIONS
): Promise<GatewayDirectTestResult> {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return { ok: false, provider, error: "Prompt is required." };
  }
  const model = typeof body.model === "string" && body.model.trim().length > 0 ? body.model.trim() : undefined;
  const request: ChatCompletionRequest = {
    model,
    messages: [{ role: "user", content: prompt }]
  };

  try {
    const result = await completions[provider](request);
    if (result.isError) {
      return {
        ok: false,
        provider,
        model: result.model || model,
        error: normalizeDirectTestError(provider, result.errorMessage || "Provider CLI returned an error.", result.model || model)
      };
    }
    const promptTokens = result.usage.promptTokens;
    const completionTokens = result.usage.completionTokens;
    return {
      ok: true,
      provider,
      model: result.model || model,
      text: result.text,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      }
    };
  } catch (error) {
    return {
      ok: false,
      provider,
      model,
      error: normalizeDirectTestError(provider, error instanceof Error ? error.message : String(error), model)
    };
  }
}
