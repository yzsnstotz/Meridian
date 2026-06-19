import assert from "node:assert/strict";
import { test } from "node:test";

import { runGatewayDirectTest } from "./direct-test";
import type { ChatCompletionRequest, CompletionResult } from "./shared";

test("runGatewayDirectTest sends the prompt to the explicitly chosen provider", async () => {
  const calls: string[] = [];
  const completions = {
    claude: async (): Promise<CompletionResult> => {
      calls.push("claude");
      throw new Error("wrong provider");
    },
    codex: async (req: ChatCompletionRequest): Promise<CompletionResult> => {
      calls.push(`codex:${req.model}:${req.messages[0]?.content}`);
      return {
        text: "codex ok",
        model: req.model ?? "codex-default",
        finishReason: "stop",
        usage: { promptTokens: 3, completionTokens: 2 }
      };
    },
    gemini: async (): Promise<CompletionResult> => {
      calls.push("gemini");
      throw new Error("wrong provider");
    }
  };

  const result = await runGatewayDirectTest(
    "codex",
    { prompt: "Say ok", model: "gpt-live-codex" },
    completions
  );

  assert.deepEqual(calls, ["codex:gpt-live-codex:Say ok"]);
  assert.deepEqual(result, {
    ok: true,
    provider: "codex",
    model: "gpt-live-codex",
    text: "codex ok",
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
  });
});

test("runGatewayDirectTest returns upstream provider errors as a structured result", async () => {
  const result = await runGatewayDirectTest(
    "gemini",
    { prompt: "Say ok", model: "gemini-live" },
    {
      claude: async () => {
        throw new Error("wrong provider");
      },
      codex: async () => {
        throw new Error("wrong provider");
      },
      gemini: async (): Promise<CompletionResult> => ({
        text: "",
        model: "gemini-live",
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0 },
        isError: true,
        errorMessage: "Gemini CLI rejected this account"
      })
    }
  );

  assert.deepEqual(result, {
    ok: false,
    provider: "gemini",
    model: "gemini-live",
    error: "Gemini CLI rejected this account"
  });
});
