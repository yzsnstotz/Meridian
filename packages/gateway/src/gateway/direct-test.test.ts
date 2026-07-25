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
    },
    antigravity: async (): Promise<CompletionResult> => {
      calls.push("antigravity");
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
      }),
      antigravity: async () => {
        throw new Error("wrong provider");
      }
    }
  );

  assert.deepEqual(result, {
    ok: false,
    provider: "gemini",
    model: "gemini-live",
    error: "Gemini CLI rejected this account"
  });
});

test("runGatewayDirectTest explains Gemini unsupported-client OAuth failures without stack traces", async () => {
  const result = await runGatewayDirectTest(
    "gemini",
    { prompt: "Say ok", model: "gemini-2.5-pro" },
    {
      claude: async () => {
        throw new Error("wrong provider");
      },
      codex: async () => {
        throw new Error("wrong provider");
      },
      gemini: async () => {
        throw new Error(
          "gemini exited 1: Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. " +
          "To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google.\n" +
          "    at throwIneligibleOrProjectIdError (bundle.js:277252:11)"
        );
      },
      antigravity: async () => {
        throw new Error("wrong provider");
      }
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.provider, "gemini");
  assert.equal(result.model, "gemini-2.5-pro");
  assert.match(result.error ?? "", /Gemini CLI reports this account or tier is no longer supported/);
  assert.match(result.error ?? "", /https:\/\/antigravity\.google/);
  assert.doesNotMatch(result.error ?? "", /throwIneligibleOrProjectIdError|bundle\.js/);
});

test("runGatewayDirectTest explains Claude model rejection without raw JSON envelope", async () => {
  const result = await runGatewayDirectTest(
    "claude",
    { prompt: "Say ok", model: "claude-haiku-3-5" },
    {
      claude: async () => {
        throw new Error(
          'claude exited 1: {"type":"result","is_error":true,"api_error_status":404,"result":"There\\u0027s an issue with the selected model (claude-haiku-3-5). It may not exist or you may not have access to it. Run --model to pick a different model."}'
        );
      },
      codex: async () => {
        throw new Error("wrong provider");
      },
      gemini: async () => {
        throw new Error("wrong provider");
      },
      antigravity: async () => {
        throw new Error("wrong provider");
      }
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.provider, "claude");
  assert.equal(result.model, "claude-haiku-3-5");
  assert.match(result.error ?? "", /Claude rejected the selected model/);
  assert.match(result.error ?? "", /claude-haiku-3-5/);
  assert.doesNotMatch(result.error ?? "", /"type":"result"|api_error_status/);
});

test("runGatewayDirectTest explains broken Antigravity app shims without shell noise", async () => {
  const result = await runGatewayDirectTest(
    "antigravity",
    { prompt: "Say ok", model: "antigravity/gemini-3-pro" },
    {
      claude: async () => {
        throw new Error("wrong provider");
      },
      codex: async () => {
        throw new Error("wrong provider");
      },
      gemini: async () => {
        throw new Error("wrong provider");
      },
      antigravity: async () => {
        throw new Error(
          "/opt/homebrew/bin/agy: line 2: /Applications/Antigravity.app/Contents/Resources/app/bin/antigravity: No such file or directory"
        );
      }
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.provider, "antigravity");
  assert.match(result.error ?? "", /Antigravity CLI shim is installed but the Antigravity app binary is missing/);
  assert.doesNotMatch(result.error ?? "", /line 2|Contents\/Resources/);
});
