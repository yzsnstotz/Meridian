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

test("ProviderModelCatalog loads Claude model candidates from local CLI binary strings", async () => {
  const catalog = new ProviderModelCatalog({
    realpathFn: async (filePath) => filePath,
    execFileFn: async (file, args) => {
      if (file === "/bin/sh" && args.join(" ").includes("command -v claude")) {
        return { stdout: "/opt/homebrew/bin/claude\n", stderr: "" };
      }
      if (file === "/bin/sh" && args.join(" ").includes("strings \"$1\"") && args[3] === "/opt/homebrew/bin/claude") {
        return {
          stdout: [
            "claude-opus-4-7",
            "claude-sonnet-4-6",
            "claude-sonnet-4-6",
            "claude-haiku-3-5",
            "claude-sonnet-3-7",
            "not-a-claude-model"
          ].join("\n"),
          stderr: ""
        };
      }
      throw new Error(`unexpected command ${file} ${args.join(" ")}`);
    },
    fetchFn: async () => {
      throw new Error("fetch should not be called for Claude OAuth model list");
    }
  });

  const result = await catalog.listModels("claude");

  assert.equal(result.provider, "claude");
  assert.deepEqual(result.models, [
    { id: "claude-haiku-3-5", label: "Claude-Haiku-3-5" },
    { id: "claude-opus-4-7", label: "Claude-Opus-4-7" },
    { id: "claude-sonnet-3-7", label: "Claude-Sonnet-3-7" },
    { id: "claude-sonnet-4-6", label: "Claude-Sonnet-4-6" }
  ]);
});

test("ProviderModelCatalog normalizes Gemini REST payloads", async () => {
  const catalog = new ProviderModelCatalog({
    geminiApiKey: "gemini-test-key",
    execFileFn: async () => {
      throw new Error("gemini CLI unavailable");
    },
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

test("ProviderModelCatalog loads Gemini models from local CLI bundle constants", async () => {
  let scannedDir = "";
  const catalog = new ProviderModelCatalog({
    realpathFn: async () => "/opt/gemini-cli/dist/index.js",
    readdirFn: async (dirPath) => {
      scannedDir = dirPath;
      return ["node_modules/@google/gemini-cli-core/dist/src/config/models.d.ts", "README.md"];
    },
    readFileFn: async (filePath) => {
      if (filePath === "/opt/gemini-cli/dist/package.json" || filePath === "/opt/gemini-cli/package.json") {
        return JSON.stringify({ name: "@google/gemini-cli" });
      }
      if (filePath.endsWith("models.d.ts")) {
        return [
          'export declare const DEFAULT_GEMINI_MODEL = "gemini-2.5-pro";',
          'export declare const DEFAULT_GEMINI_FLASH_MODEL = "gemini-2.5-flash";',
          'export declare const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";',
          'export declare const PREVIEW_GEMINI_MODEL_AUTO = "auto-gemini-3";'
        ].join("\n");
      }
      return "";
    },
    execFileFn: async (file, args) => {
      if (file === "/bin/sh" && args.join(" ").includes("command -v gemini")) {
        return { stdout: "/usr/local/bin/gemini\n", stderr: "" };
      }
      throw new Error(`unexpected command ${file} ${args.join(" ")}`);
    },
    fetchFn: async () => {
      throw new Error("fetch should not be called for Gemini OAuth model list");
    }
  });

  const result = await catalog.listModels("gemini");

  assert.equal(result.provider, "gemini");
  assert.equal(scannedDir, "/opt/gemini-cli");
  assert.deepEqual(result.models, [
    { id: "auto-gemini-3", label: "Auto-Gemini-3" },
    { id: "gemini-2.5-flash", label: "Gemini-2.5-Flash" },
    { id: "gemini-2.5-pro", label: "Gemini-2.5-Pro" }
  ]);
});

test("ProviderModelCatalog loads Antigravity models from agy models", async () => {
  const catalog = new ProviderModelCatalog({
    realpathFn: async (filePath) => filePath,
    execFileFn: async (file, args) => {
      if (file === "/bin/sh" && args.join(" ").includes("command -v agy")) {
        return { stdout: "/opt/homebrew/bin/agy\n", stderr: "" };
      }
      if (file === "agy" && args.join(" ") === "models") {
        return {
          stdout: [
            "Available models:",
            "- gemini-3-pro",
            "- gemini-2.5-flash",
            "- text-embedding-004"
          ].join("\n"),
          stderr: ""
        };
      }
      throw new Error(`unexpected command ${file} ${args.join(" ")}`);
    },
    fetchFn: async () => {
      throw new Error("fetch should not be called for Antigravity OAuth model list");
    }
  });

  const result = await catalog.listModels("antigravity");

  assert.equal(result.provider, "antigravity");
  assert.deepEqual(result.models, [
    { id: "antigravity/gemini-2.5-flash", label: "Gemini-2.5-Flash" },
    { id: "antigravity/gemini-3-pro", label: "Gemini-3-Pro" }
  ]);
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
