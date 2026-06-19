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
        error: result.errorMessage || "Provider CLI returned an error."
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
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
