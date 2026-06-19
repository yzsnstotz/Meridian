import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProviderModelCatalogResult } from "../../shared/model-catalog";
import type { AgentType } from "../../types";
import { listGatewayModels } from "./model-list";
import type { ProvidersStatus } from "./login";

test("listGatewayModels uses live catalog results instead of static gateway constants", async () => {
  const status: ProvidersStatus = {
    claude: { installed: true, connected: true },
    codex: { installed: true, connected: true },
    gemini: { installed: true, connected: false }
  };
  const calls: AgentType[] = [];
  const catalog = {
    async listModels(provider: AgentType): Promise<ProviderModelCatalogResult> {
      calls.push(provider);
      if (provider === "claude") {
        return { provider, models: [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }] };
      }
      if (provider === "codex") {
        return { provider, models: [{ id: "gpt-live-codex", label: "GPT Live Codex" }] };
      }
      throw new Error(`unexpected provider ${provider}`);
    }
  };

  const result = await listGatewayModels(status, catalog);

  assert.deepEqual(calls, ["claude", "codex"]);
  assert.deepEqual(result.data, [
    { id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic-subscription" },
    { id: "gpt-live-codex", object: "model", owned_by: "openai-subscription" }
  ]);
  assert.equal(result.errors, undefined);
  assert.equal(result.data.some((model) => model.id === "claude-opus-4-8"), false);
  assert.equal(result.data.some((model) => model.id === "gpt-5.5"), false);
});

test("listGatewayModels reports per-provider catalog failures without falling back to stale models", async () => {
  const status: ProvidersStatus = {
    claude: { installed: true, connected: true },
    codex: { installed: true, connected: false },
    gemini: { installed: true, connected: true }
  };
  const catalog = {
    async listModels(provider: AgentType): Promise<ProviderModelCatalogResult> {
      if (provider === "claude") {
        throw new Error("Claude CLI does not expose a model catalog");
      }
      if (provider === "gemini") {
        throw new Error("Gemini live catalog unavailable");
      }
      return { provider, models: [] };
    }
  };

  const result = await listGatewayModels(status, catalog);

  assert.deepEqual(result.data, []);
  assert.deepEqual(result.errors, {
    claude: "Claude CLI does not expose a model catalog",
    gemini: "Gemini live catalog unavailable"
  });
});
