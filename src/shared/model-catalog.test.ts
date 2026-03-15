import assert from "node:assert/strict";
import { test } from "node:test";

import { ProviderModelCatalog } from "./model-catalog";

test("ProviderModelCatalog loads Codex models from codex app-server", async () => {
  const catalog = new ProviderModelCatalog({
    execFileFn: async () => ({
      stdout: [
        JSON.stringify({
          id: "meridian-codex-init",
          result: {
            userAgent: "meridian/0.0.0"
          }
        }),
        JSON.stringify({
          id: "meridian-codex-model-list",
          result: {
            data: [
              {
                id: "gpt-5.3-codex",
                displayName: "GPT-5.3 Codex",
                hidden: false
              },
              {
                id: "gpt-5.2-codex",
                displayName: "GPT-5.2 Codex",
                hidden: true
              }
            ]
          }
        })
      ].join("\n"),
      stderr: ""
    }),
    fetchFn: async () => {
      throw new Error("fetch should not be called for codex app-server model list");
    }
  });

  const result = await catalog.listModels("codex");

  assert.equal(result.provider, "codex");
  assert.deepEqual(result.models, [{ id: "gpt-5.3-codex", label: "GPT-5.3 Codex" }]);
});

test("ProviderModelCatalog falls back to OpenAI models for Codex when app-server path fails", async () => {
  const catalog = new ProviderModelCatalog({
    openAiApiKey: "openai-test-key",
    execFileFn: async () => {
      throw new Error("codex app-server unavailable");
    },
    readFileFn: async () => {
      throw new Error("local cache unavailable");
    },
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "text-embedding-3-small" },
            { id: "gpt-5.4" },
            { id: "codex-5.3-max" }
          ]
        }),
        { status: 200 }
      )
  });

  const result = await catalog.listModels("codex");

  assert.equal(result.provider, "codex");
  assert.deepEqual(result.models, [
    { id: "codex-5.3-max", label: "Codex-5.3-Max" },
    { id: "gpt-5.4", label: "GPT-5.4" }
  ]);
});

test("ProviderModelCatalog falls back to local Codex cache when app-server path fails", async () => {
  const catalog = new ProviderModelCatalog({
    execFileFn: async () => {
      throw new Error("codex app-server unavailable");
    },
    readFileFn: async () =>
      JSON.stringify({
        models: [
          {
            slug: "gpt-5.4",
            display_name: "GPT-5.4",
            visibility: "list"
          },
          {
            slug: "gpt-5.1-codex",
            display_name: "GPT-5.1 Codex",
            visibility: "hide"
          },
          {
            slug: "codex-5.3-max",
            visibility: "list"
          }
        ]
      }),
    fetchFn: async () => {
      throw new Error("fetch should not be called when cache fallback succeeds");
    }
  });

  const result = await catalog.listModels("codex");

  assert.equal(result.provider, "codex");
  assert.deepEqual(result.models, [
    { id: "codex-5.3-max", label: "Codex-5.3-Max" },
    { id: "gpt-5.4", label: "GPT-5.4" }
  ]);
});

test("ProviderModelCatalog surfaces Codex app-server failure when no OpenAI fallback is configured", async () => {
  const catalog = new ProviderModelCatalog({
    execFileFn: async () => {
      throw new Error("codex app-server unavailable");
    },
    readFileFn: async () => {
      throw new Error("local cache unavailable");
    }
  });

  await assert.rejects(
    async () => await catalog.listModels("codex"),
    /Local models cache fallback failed: local cache unavailable/
  );
});

test("ProviderModelCatalog normalizes Gemini REST payloads", async () => {
  const catalog = new ProviderModelCatalog({
    geminiApiKey: "gemini-test-key",
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              name: "models/gemini-2.5-pro",
              displayName: "Gemini 2.5 Pro",
              supportedGenerationMethods: ["generateContent"]
            },
            {
              name: "models/text-embedding-004",
              displayName: "Embedding 004",
              supportedGenerationMethods: ["embedContent"]
            }
          ]
        }),
        { status: 200 }
      )
  });

  const result = await catalog.listModels("gemini");

  assert.equal(result.provider, "gemini");
  assert.deepEqual(result.models, [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }]);
});

test("ProviderModelCatalog parses Cursor CLI output", async () => {
  const catalog = new ProviderModelCatalog({
    execFileFn: async () => ({
      stdout: "Available models:\n- gpt-5\n- claude-3.7-sonnet\n",
      stderr: ""
    })
  });

  const result = await catalog.listModels("cursor");

  assert.equal(result.provider, "cursor");
  assert.deepEqual(result.models, [
    { id: "claude-3.7-sonnet", label: "Claude-3.7-Sonnet" },
    { id: "gpt-5", label: "GPT-5" }
  ]);
});
