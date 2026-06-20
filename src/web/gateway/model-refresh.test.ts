import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ProviderModelCatalogProvider, ProviderModelCatalogResult } from "../../shared/model-catalog";
import type { ChatCompletionRequest, CompletionResult } from "./shared";
import type { ProvidersStatus } from "./login";
import { GatewayModelRegistry } from "./model-refresh";

function status(overrides: Partial<ProvidersStatus> = {}): ProvidersStatus {
  return {
    claude: { installed: true, connected: false },
    codex: { installed: true, connected: false },
    gemini: { installed: true, connected: false },
    antigravity: { installed: true, connected: false },
    ...overrides
  };
}

function ok(model: string | undefined): CompletionResult {
  return {
    text: "OK",
    model: model || "provider-default",
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1 }
  };
}

function rejected(model: string | undefined, message = "model unavailable"): CompletionResult {
  return {
    text: "",
    model: model || "provider-default",
    finishReason: "stop",
    usage: { promptTokens: 0, completionTokens: 0 },
    isError: true,
    errorMessage: message
  };
}

test("GatewayModelRegistry does not expose unverified Claude and Gemini candidates before refresh", async () => {
  const catalogCalls: ProviderModelCatalogProvider[] = [];
  const registry = new GatewayModelRegistry({
    cachePath: join(mkdtempSync(join(tmpdir(), "meridian-model-cache-")), "models.json"),
    catalog: {
      async listModels(provider: ProviderModelCatalogProvider): Promise<ProviderModelCatalogResult> {
        catalogCalls.push(provider);
        return {
          provider,
          models: [{ id: provider === "claude" ? "claude-haiku-3-5" : "gemini-dead", label: "dead" }]
        };
      }
    }
  });

  const result = await registry.list(status({
    claude: { installed: true, connected: true },
    gemini: { installed: true, connected: true }
  }));

  assert.deepEqual(catalogCalls, []);
  assert.deepEqual(result.data, []);
  assert.match(result.errors?.claude ?? "", /Refresh models/i);
  assert.match(result.errors?.gemini ?? "", /Refresh models/i);
});

test("GatewayModelRegistry refreshes and caches only successfully probed CLI models", async () => {
  const cachePath = join(mkdtempSync(join(tmpdir(), "meridian-model-cache-")), "models.json");
  const probed: string[] = [];
  const registry = new GatewayModelRegistry({
    cachePath,
    now: () => new Date("2026-06-20T01:02:03.000Z"),
    catalog: {
      async listModels(provider: ProviderModelCatalogProvider): Promise<ProviderModelCatalogResult> {
        if (provider === "claude") {
          return {
            provider,
            models: [
              { id: "claude-haiku-3-5", label: "Claude Haiku 3.5" },
              { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }
            ]
          };
        }
        if (provider === "gemini") {
          return {
            provider,
            models: [
              { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
              { id: "gemini-old", label: "Gemini Old" }
            ]
          };
        }
        if (provider === "antigravity") {
          return {
            provider,
            models: [
              { id: "antigravity/gemini-3-pro", label: "Gemini 3 Pro" },
              { id: "antigravity/gemini-dead", label: "Gemini Dead" }
            ]
          };
        }
        throw new Error(`unexpected provider ${provider}`);
      }
    },
    completions: {
      claude: async (req: ChatCompletionRequest) => {
        probed.push(`claude:${req.model ?? ""}`);
        return req.model === "claude-sonnet-4-6"
          ? ok(req.model)
          : rejected(req.model, "selected model may not exist");
      },
      gemini: async (req: ChatCompletionRequest) => {
        probed.push(`gemini:${req.model ?? ""}`);
        return req.model === "gemini-2.5-pro"
          ? ok(req.model)
          : rejected(req.model, "model not found");
      },
      antigravity: async (req: ChatCompletionRequest) => {
        probed.push(`antigravity:${req.model ?? ""}`);
        return req.model === "antigravity/gemini-3-pro"
          ? ok(req.model)
          : rejected(req.model, "model not found");
      }
    }
  });

  const refreshed = await registry.refresh(status({
    claude: { installed: true, connected: true },
    gemini: { installed: true, connected: true },
    antigravity: { installed: true, connected: true }
  }));

  assert.deepEqual(probed, [
    "claude:claude-haiku-3-5",
    "claude:claude-sonnet-4-6",
    "gemini:gemini-2.5-pro",
    "gemini:gemini-old",
    "antigravity:antigravity/gemini-3-pro",
    "antigravity:antigravity/gemini-dead"
  ]);
  assert.deepEqual(refreshed.providers.claude?.models, [
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }
  ]);
  assert.deepEqual(refreshed.providers.gemini?.models, [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }
  ]);
  assert.deepEqual(refreshed.providers.antigravity?.models, [
    { id: "antigravity/gemini-3-pro", label: "Gemini 3 Pro" }
  ]);
  assert.equal(existsSync(cachePath), true);
  assert.match(readFileSync(cachePath, "utf8"), /claude-sonnet-4-6/);
  assert.doesNotMatch(readFileSync(cachePath, "utf8"), /claude-haiku-3-5/);
  assert.match(readFileSync(cachePath, "utf8"), /antigravity\/gemini-3-pro/);

  const listed = await registry.list(status({
    claude: { installed: true, connected: true },
    gemini: { installed: true, connected: true },
    antigravity: { installed: true, connected: true }
  }));
  assert.deepEqual(listed.data, [
    { id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic-subscription" },
    { id: "antigravity/gemini-3-pro", object: "model", owned_by: "antigravity-subscription" },
    { id: "gemini-2.5-pro", object: "model", owned_by: "gemini-subscription" }
  ]);
  assert.equal(listed.errors, undefined);
});

test("GatewayModelRegistry refreshes one selected provider without clearing other cached providers", async () => {
  const cachePath = join(mkdtempSync(join(tmpdir(), "meridian-model-cache-")), "models.json");
  const catalogCalls: ProviderModelCatalogProvider[] = [];
  const probed: string[] = [];
  const registry = new GatewayModelRegistry({
    cachePath,
    now: () => new Date(catalogCalls.length < 4 ? "2026-06-20T01:02:03.000Z" : "2026-06-20T02:03:04.000Z"),
    catalog: {
      async listModels(provider: ProviderModelCatalogProvider): Promise<ProviderModelCatalogResult> {
        catalogCalls.push(provider);
        if (provider === "claude") {
          return { provider, models: [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }] };
        }
        if (provider === "gemini") {
          return { provider, models: [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }] };
        }
        if (provider === "antigravity") {
          const label = catalogCalls.filter((entry) => entry === "antigravity").length === 1
            ? "Gemini 3.5 Flash (Medium)"
            : "Claude Opus 4.6 (Thinking)";
          return { provider, models: [{ id: `antigravity/${label}`, label }] };
        }
        return { provider, models: [{ id: "gpt-live-codex", label: "GPT Live Codex" }] };
      }
    },
    completions: {
      claude: async (req: ChatCompletionRequest) => {
        probed.push(`claude:${req.model ?? ""}`);
        return ok(req.model);
      },
      gemini: async (req: ChatCompletionRequest) => {
        probed.push(`gemini:${req.model ?? ""}`);
        return ok(req.model);
      },
      antigravity: async (req: ChatCompletionRequest) => {
        probed.push(`antigravity:${req.model ?? ""}`);
        return ok(req.model);
      }
    }
  });

  await registry.refresh(status({
    claude: { installed: true, connected: true },
    codex: { installed: true, connected: true },
    gemini: { installed: true, connected: true },
    antigravity: { installed: true, connected: true }
  }));
  const refreshed = await registry.refresh(status({
    claude: { installed: true, connected: true },
    codex: { installed: true, connected: true },
    gemini: { installed: true, connected: true },
    antigravity: { installed: true, connected: true }
  }), { provider: "antigravity" });

  assert.deepEqual(catalogCalls, ["claude", "codex", "gemini", "antigravity", "antigravity"]);
  assert.deepEqual(probed, [
    "claude:claude-sonnet-4-6",
    "gemini:gemini-2.5-pro",
    "antigravity:antigravity/Gemini 3.5 Flash (Medium)",
    "antigravity:antigravity/Claude Opus 4.6 (Thinking)"
  ]);
  assert.deepEqual(refreshed.providers.antigravity?.models, [
    { id: "antigravity/Claude Opus 4.6 (Thinking)", label: "Claude Opus 4.6 (Thinking)" }
  ]);

  const listed = await registry.list(status({
    claude: { installed: true, connected: true },
    codex: { installed: true, connected: true },
    gemini: { installed: true, connected: true },
    antigravity: { installed: true, connected: true }
  }));

  assert.deepEqual(listed.data.map((model) => model.id), [
    "claude-sonnet-4-6",
    "antigravity/Claude Opus 4.6 (Thinking)",
    "gemini-2.5-pro",
    "gpt-live-codex"
  ]);
});

test("GatewayModelRegistry marks Gemini unsupported-client accounts unavailable during refresh", async () => {
  const registry = new GatewayModelRegistry({
    cachePath: join(mkdtempSync(join(tmpdir(), "meridian-model-cache-")), "models.json"),
    catalog: {
      async listModels(provider: ProviderModelCatalogProvider): Promise<ProviderModelCatalogResult> {
        assert.equal(provider, "gemini");
        return {
          provider,
          models: [
            { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
            { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" }
          ]
        };
      }
    },
    completions: {
      gemini: async (req: ChatCompletionRequest) =>
        rejected(
          req.model,
          "IneligibleTierError: This client is no longer supported. reasonCode: 'UNSUPPORTED_CLIENT'. migrate to the Antigravity suite"
        )
    }
  });

  const refreshed = await registry.refresh(status({
    gemini: { installed: true, connected: true }
  }));
  const listed = await registry.list(status({
    gemini: { installed: true, connected: true }
  }));

  assert.deepEqual(refreshed.providers.gemini?.models, []);
  assert.match(refreshed.providers.gemini?.error ?? "", /Antigravity/);
  assert.deepEqual(listed.data, []);
  assert.match(listed.errors?.gemini ?? "", /Antigravity/);
});
