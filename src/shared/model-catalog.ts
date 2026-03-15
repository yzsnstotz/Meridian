import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { config } from "../config";
import type { AgentType, ProviderModel } from "../types";

const execFileAsync = promisify(execFile);
type ExecFileResult = { stdout: string; stderr: string };
type ExecFileFn = (file: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => Promise<ExecFileResult>;
type ReadFileFn = (filePath: string, encoding: BufferEncoding) => Promise<string>;

interface OpenAiModelRecord {
  id?: unknown;
}

interface AnthropicModelRecord {
  id?: unknown;
  display_name?: unknown;
}

interface GeminiModelRecord {
  name?: unknown;
  displayName?: unknown;
  supportedGenerationMethods?: unknown;
}

interface CodexModelRecord {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  hidden?: unknown;
}

interface CodexCachedModelRecord {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
}

export interface ProviderModelCatalogResult {
  provider: AgentType;
  models: ProviderModel[];
}

export interface ProviderModelCatalogOptions {
  fetchFn?: typeof fetch;
  execFileFn?: ExecFileFn;
  readFileFn?: ReadFileFn;
  openAiApiKey?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  cursorApiKey?: string;
  codexModelsCachePath?: string;
}

const OPENAI_MODEL_PREFIXES = ["gpt-", "codex-", "o1", "o3", "o4"];
const OPENAI_MODEL_EXCLUDES = [
  "babbage",
  "computer-use-",
  "dall-e",
  "davinci",
  "embedding",
  "gpt-image-",
  "moderation",
  "omni-moderation",
  "search-",
  "similarity",
  "text-embedding-",
  "tts-",
  "whisper-"
];
const CODEX_APP_SERVER_INIT_REQUEST_ID = "meridian-codex-init";
const CODEX_APP_SERVER_MODEL_LIST_REQUEST_ID = "meridian-codex-model-list";
const CODEX_APP_SERVER_MODEL_LIST_LIMIT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatModelLabel(modelId: string): string {
  return modelId
    .split(/[\/_-]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^\d+(\.\d+)*$/.test(part)) {
        return part;
      }
      if (part.toLowerCase() === "gpt") {
        return "GPT";
      }
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join("-");
}

function sortAndDeduplicateModels(models: ProviderModel[]): ProviderModel[] {
  const deduped = new Map<string, ProviderModel>();
  for (const model of models) {
    deduped.set(model.id, model);
  }
  return Array.from(deduped.values()).sort((left, right) => left.label.localeCompare(right.label));
}

function expectApiKey(provider: AgentType, value: string | undefined): string {
  if (!value) {
    throw new Error(`No API key configured for provider=${provider}`);
  }
  return value;
}

export class ProviderModelCatalog {
  private readonly fetchFn: typeof fetch;
  private readonly execFileFn: ExecFileFn;
  private readonly readFileFn: ReadFileFn;
  private readonly openAiApiKey: string | undefined;
  private readonly anthropicApiKey: string | undefined;
  private readonly geminiApiKey: string | undefined;
  private readonly cursorApiKey: string | undefined;
  private readonly codexModelsCachePath: string;

  constructor(options: ProviderModelCatalogOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.execFileFn =
      options.execFileFn ??
      (async (file, args, options) => {
        const result = await execFileAsync(file, args, options);
        return {
          stdout: typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8"),
          stderr: typeof result.stderr === "string" ? result.stderr : result.stderr.toString("utf8")
        };
      });
    this.readFileFn = options.readFileFn ?? fs.readFile;
    this.openAiApiKey = options.openAiApiKey ?? config.OPENAI_API_KEY;
    this.anthropicApiKey = options.anthropicApiKey ?? config.ANTHROPIC_API_KEY;
    this.geminiApiKey = options.geminiApiKey ?? config.GEMINI_API_KEY;
    this.cursorApiKey = options.cursorApiKey ?? config.CURSOR_API_KEY;
    this.codexModelsCachePath = options.codexModelsCachePath ?? path.join(os.homedir(), ".codex", "models_cache.json");
  }

  async listModels(provider: AgentType): Promise<ProviderModelCatalogResult> {
    switch (provider) {
      case "codex":
        return {
          provider,
          models: await this.listCodexModels()
        };
      case "claude":
        return {
          provider,
          models: await this.listAnthropicModels()
        };
      case "gemini":
        return {
          provider,
          models: await this.listGeminiModels()
        };
      case "cursor":
        return {
          provider,
          models: await this.listCursorModels()
        };
    }
  }

  private async listCodexModels(): Promise<ProviderModel[]> {
    try {
      return await this.listCodexModelsViaAppServer();
    } catch (codexError) {
      const codexErrorMessage = codexError instanceof Error ? codexError.message : String(codexError);
      try {
        return await this.listCodexModelsViaLocalCache();
      } catch (cacheError) {
        const cacheErrorMessage = cacheError instanceof Error ? cacheError.message : String(cacheError);
        if (!this.openAiApiKey) {
          throw new Error(
            `Codex model catalog failed via codex app-server: ${codexErrorMessage}. ` +
            `Local models cache fallback failed: ${cacheErrorMessage}. ` +
            "Set OPENAI_API_KEY to enable OpenAI fallback."
          );
        }

        try {
          return await this.listOpenAiModels();
        } catch (openAiError) {
          const openAiErrorMessage = openAiError instanceof Error ? openAiError.message : String(openAiError);
          throw new Error(
            `Codex model catalog failed via codex app-server: ${codexErrorMessage}. ` +
            `Local models cache fallback failed: ${cacheErrorMessage}. ` +
            `OpenAI fallback failed: ${openAiErrorMessage}`
          );
        }
      }
    }
  }

  private async listCodexModelsViaLocalCache(): Promise<ProviderModel[]> {
    const raw = await this.readFileFn(this.codexModelsCachePath, "utf8");
    const payload = JSON.parse(raw) as { models?: unknown };
    const records = Array.isArray(payload.models) ? payload.models : [];
    const models = records.flatMap((entry) => {
      if (!isRecord(entry)) {
        return [];
      }
      const record = entry as CodexCachedModelRecord;
      const slug = typeof record.slug === "string" ? record.slug.trim() : "";
      if (!slug) {
        return [];
      }
      if (typeof record.visibility === "string" && record.visibility.trim().toLowerCase() === "hide") {
        return [];
      }
      const displayName = typeof record.display_name === "string" && record.display_name.trim().length > 0
        ? record.display_name.trim()
        : formatModelLabel(slug);
      return [
        {
          id: slug,
          label: displayName
        }
      ];
    });

    if (models.length === 0) {
      throw new Error("codex models cache returned no selectable models");
    }
    return sortAndDeduplicateModels(models);
  }

  private async listCodexModelsViaAppServer(): Promise<ProviderModel[]> {
    const initializeRequest = JSON.stringify({
      id: CODEX_APP_SERVER_INIT_REQUEST_ID,
      method: "initialize",
      params: {
        clientInfo: {
          name: "meridian",
          title: "Meridian",
          version: "0.0.0"
        },
        capabilities: null
      }
    });
    const initializedNotification = JSON.stringify({
      method: "initialized"
    });
    const modelListRequest = JSON.stringify({
      id: CODEX_APP_SERVER_MODEL_LIST_REQUEST_ID,
      method: "model/list",
      params: {
        includeHidden: false,
        limit: CODEX_APP_SERVER_MODEL_LIST_LIMIT
      }
    });

    const requestScript = [
      "cat <<'EOF' | codex app-server",
      initializeRequest,
      initializedNotification,
      modelListRequest,
      "EOF"
    ].join("\n");

    const { stdout } = await this.execFileFn("/bin/sh", ["-lc", requestScript], {
      env: process.env
    });

    const responseLines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    let modelListResult: unknown = null;
    for (const line of responseLines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) {
        continue;
      }
      if (parsed.id !== CODEX_APP_SERVER_MODEL_LIST_REQUEST_ID) {
        continue;
      }
      if ("error" in parsed) {
        const message = isRecord(parsed.error) && typeof parsed.error.message === "string"
          ? parsed.error.message
          : "unknown error";
        throw new Error(`codex app-server model/list failed: ${message}`);
      }
      modelListResult = parsed.result;
      break;
    }

    if (!isRecord(modelListResult)) {
      throw new Error("codex app-server did not return model/list result");
    }

    const records = Array.isArray(modelListResult.data) ? modelListResult.data : [];
    const models = records.flatMap((entry) => {
      if (!isRecord(entry)) {
        return [];
      }
      const record = entry as CodexModelRecord;
      if (record.hidden === true) {
        return [];
      }
      const candidateId = typeof record.id === "string"
        ? record.id.trim()
        : typeof record.model === "string"
          ? record.model.trim()
          : "";
      if (!candidateId) {
        return [];
      }
      const displayName = typeof record.displayName === "string" && record.displayName.trim().length > 0
        ? record.displayName.trim()
        : formatModelLabel(candidateId);
      return [
        {
          id: candidateId,
          label: displayName
        }
      ];
    });

    if (models.length === 0) {
      throw new Error("codex app-server returned no selectable models");
    }
    return sortAndDeduplicateModels(models);
  }

  private async listOpenAiModels(): Promise<ProviderModel[]> {
    const apiKey = expectApiKey("codex", this.openAiApiKey);
    const response = await this.fetchFn("https://api.openai.com/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });
    if (!response.ok) {
      throw new Error(`OpenAI model catalog request failed with HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { data?: unknown };
    const records = Array.isArray(payload.data) ? payload.data : [];
    const models = records.flatMap((entry) => {
      const id = isRecord(entry) ? entry.id : undefined;
      if (typeof id !== "string") {
        return [];
      }
      const normalizedId = id.trim();
      if (!normalizedId) {
        return [];
      }
      const lowerId = normalizedId.toLowerCase();
      if (!OPENAI_MODEL_PREFIXES.some((prefix) => lowerId.startsWith(prefix))) {
        return [];
      }
      if (OPENAI_MODEL_EXCLUDES.some((prefix) => lowerId.includes(prefix))) {
        return [];
      }
      return [
        {
          id: normalizedId,
          label: formatModelLabel(normalizedId)
        }
      ];
    });
    if (models.length === 0) {
      throw new Error("OpenAI returned no selectable chat models");
    }
    return sortAndDeduplicateModels(models);
  }

  private async listAnthropicModels(): Promise<ProviderModel[]> {
    const apiKey = expectApiKey("claude", this.anthropicApiKey);
    const response = await this.fetchFn("https://api.anthropic.com/v1/models", {
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey
      }
    });
    if (!response.ok) {
      throw new Error(`Anthropic model catalog request failed with HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { data?: unknown; models?: unknown };
    const records = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
    const models = records.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.id !== "string") {
        return [];
      }
      if (!entry.id.toLowerCase().includes("claude")) {
        return [];
      }
      const displayName = typeof entry.display_name === "string" && entry.display_name.trim().length > 0
        ? entry.display_name.trim()
        : formatModelLabel(entry.id);
      return [
        {
          id: entry.id,
          label: displayName
        }
      ];
    });
    if (models.length === 0) {
      throw new Error("Anthropic returned no Claude models");
    }
    return sortAndDeduplicateModels(models);
  }

  private async listGeminiModels(): Promise<ProviderModel[]> {
    const apiKey = expectApiKey("gemini", this.geminiApiKey);
    const response = await this.fetchFn(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
    if (!response.ok) {
      throw new Error(`Gemini model catalog request failed with HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { models?: unknown };
    const records = Array.isArray(payload.models) ? payload.models : [];
    const models = records.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.name !== "string") {
        return [];
      }
      const normalizedName = entry.name.replace(/^models\//, "");
      if (!normalizedName.toLowerCase().startsWith("gemini")) {
        return [];
      }
      const methods = Array.isArray(entry.supportedGenerationMethods) ? entry.supportedGenerationMethods : [];
      if (methods.length > 0 && !methods.some((method) => method === "generateContent")) {
        return [];
      }
      const displayName =
        typeof entry.displayName === "string" && entry.displayName.trim().length > 0
          ? entry.displayName.trim()
          : formatModelLabel(normalizedName);
      return [
        {
          id: normalizedName,
          label: displayName
        }
      ];
    });
    if (models.length === 0) {
      throw new Error("Gemini returned no interactive models");
    }
    return sortAndDeduplicateModels(models);
  }

  private async listCursorModels(): Promise<ProviderModel[]> {
    const env = this.cursorApiKey
      ? {
          ...process.env,
          CURSOR_API_KEY: this.cursorApiKey
        }
      : process.env;
    const { stdout } = await this.execFileFn("cursor-agent", ["models"], { env });
    const models = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.toLowerCase().startsWith("available models"))
      .flatMap((line) => {
        const normalized = line.replace(/^[*\-•\d.\s]+/, "").trim();
        if (!normalized) {
          return [];
        }
        const id = normalized.split(/\s{2,}/)[0] ?? normalized;
        return [
          {
            id,
            label: formatModelLabel(id)
          }
        ];
      });
    if (models.length === 0) {
      throw new Error("Cursor returned no selectable models");
    }
    return sortAndDeduplicateModels(models);
  }
}
