import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { config } from "../config";
import type { AgentType, ProviderModel } from "../types";

const execFileAsync = promisify(execFile);
type ExecFileResult = { stdout: string; stderr: string };
type ExecFileFn = (
  file: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeout?: number; killSignal?: NodeJS.Signals; maxBuffer?: number }
) => Promise<ExecFileResult>;
type ReadFileFn = (filePath: string, encoding: BufferEncoding) => Promise<string>;
type ReadDirFn = (dirPath: string, options?: { recursive?: boolean }) => Promise<string[]>;
type RealPathFn = (filePath: string) => Promise<string>;

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

export type ProviderModelCatalogProvider = AgentType | "antigravity";

export interface ProviderModelCatalogResult<TProvider extends ProviderModelCatalogProvider = ProviderModelCatalogProvider> {
  provider: TProvider;
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
  readdirFn?: ReadDirFn;
  realpathFn?: RealPathFn;
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
const CLI_DISCOVERY_TIMEOUT_MS = 8000;
// Outer safety net on the Node side. Coreutils `timeout 15` kills the inner
// pipeline; this gives Node a few extra seconds to drain stdout before
// SIGTERM-ing the immediate child.
const CODEX_APP_SERVER_NODE_TIMEOUT_MS = 20_000;

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

function isShellSafeCommand(command: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(command);
}

function modelRecordsFromIds(ids: string[]): ProviderModel[] {
  return sortAndDeduplicateModels(
    ids.map((id) => ({
      id,
      label: formatModelLabel(id)
    }))
  );
}

function parseClaudeCliModelIds(raw: string): string[] {
  const ids = new Set<string>();
  for (const match of raw.matchAll(/\bclaude-(?:opus|sonnet|haiku)-[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\b/g)) {
    const id = match[0].trim();
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

function parseGeminiCliModelIds(raw: string): string[] {
  const ids = new Set<string>();
  const constantRe = /\b(?:PREVIEW|DEFAULT)_GEMINI[A-Z0-9_]*MODEL(?:_AUTO)?\s*=\s*"([^"]+)"/g;
  for (const match of raw.matchAll(constantRe)) {
    const id = match[1]?.trim();
    if (!id) continue;
    const lower = id.toLowerCase();
    if (!(lower.startsWith("gemini-") || lower.startsWith("auto-gemini-"))) continue;
    if (lower.includes("embedding")) continue;
    ids.add(id);
  }
  return Array.from(ids);
}

function isSelectableAntigravityModelId(id: string): boolean {
  const lower = id.toLowerCase();
  if (!/^(gemini[- ]|auto-gemini[- ]|claude[- ]|gpt[- ]|codex[- ]|o\d|antigravity[- ])/i.test(lower)) {
    return false;
  }
  return !/(embedding|text-embedding|image|tts|whisper|search)/.test(lower);
}

function antigravityGatewayId(id: string): string {
  return id.toLowerCase().startsWith("antigravity/") ? id : `antigravity/${id}`;
}

function antigravityBareId(id: string): string {
  return id.replace(/^models\//i, "").replace(/^antigravity\//i, "").trim();
}

function parseAntigravityJsonModels(value: unknown): ProviderModel[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseAntigravityJsonModels(entry));
  }
  if (!isRecord(value)) {
    if (typeof value !== "string") return [];
    const id = antigravityBareId(value);
    return id && isSelectableAntigravityModelId(id)
      ? [{ id: antigravityGatewayId(id), label: formatModelLabel(id) }]
      : [];
  }

  const nested = Array.isArray(value.models)
    ? value.models
    : Array.isArray(value.data)
      ? value.data
      : undefined;
  if (nested) return parseAntigravityJsonModels(nested);

  const candidate = [value.id, value.model, value.name, value.slug]
    .find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  if (!candidate) return [];
  const id = antigravityBareId(candidate);
  if (!id || !isSelectableAntigravityModelId(id)) return [];
  const displayName = [value.displayName, value.display_name, value.label, value.title]
    .find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return [{ id: antigravityGatewayId(id), label: displayName?.trim() || formatModelLabel(id) }];
}

function parseAntigravityTextModels(raw: string): ProviderModel[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      if (/^(available\s+models?|models?|model\s+id|id|name)\b[:\s]*$/i.test(line)) return [];
      const normalized = line
        .replace(/^[*\-•\d.)\s]+/, "")
        .replace(/^`|`$/g, "")
        .trim();
      const firstToken = (normalized.split(/\s+/)[0] ?? "").replace(/[,;:]$/, "");
      const displayStyle = /\s/.test(normalized) && /^(gemini|claude|gpt|codex|o\d)\b/i.test(normalized);
      const id = antigravityBareId(displayStyle ? normalized : firstToken);
      if (!id || !isSelectableAntigravityModelId(id)) return [];
      return [{ id: antigravityGatewayId(id), label: displayStyle ? id : formatModelLabel(id) }];
    });
}

function parseAntigravityModels(raw: string): ProviderModel[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    return sortAndDeduplicateModels(parseAntigravityJsonModels(JSON.parse(trimmed) as unknown));
  } catch {
    return sortAndDeduplicateModels(parseAntigravityTextModels(raw));
  }
}

export class ProviderModelCatalog {
  private readonly fetchFn: typeof fetch;
  private readonly execFileFn: ExecFileFn;
  private readonly readFileFn: ReadFileFn;
  private readonly readdirFn: ReadDirFn;
  private readonly realpathFn: RealPathFn;
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
    this.readdirFn = options.readdirFn ?? (async (dirPath, options) => {
      const entries = await fs.readdir(dirPath, options);
      return entries.map((entry) => entry.toString());
    });
    this.realpathFn = options.realpathFn ?? fs.realpath;
    this.openAiApiKey = options.openAiApiKey ?? config.OPENAI_API_KEY;
    this.anthropicApiKey = options.anthropicApiKey ?? config.ANTHROPIC_API_KEY;
    this.geminiApiKey = options.geminiApiKey ?? config.GEMINI_API_KEY;
    this.cursorApiKey = options.cursorApiKey ?? config.CURSOR_API_KEY;
    this.codexModelsCachePath = options.codexModelsCachePath ?? path.join(os.homedir(), ".codex", "models_cache.json");
  }

  async listModels<TProvider extends ProviderModelCatalogProvider>(
    provider: TProvider
  ): Promise<ProviderModelCatalogResult<TProvider>> {
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
      case "antigravity":
        return {
          provider,
          models: await this.listAntigravityModels()
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

    // Wrap the `cat <<EOF | codex app-server` pipeline with the `timeout`
    // utility so the WHOLE process group (shell + cat + codex node shim +
    // native codex Rust binary) is killed if codex doesn't return inside the
    // budget. Without this, codex app-server keeps its stdin pipe waiting
    // indefinitely after EOF, and every model/list call permanently leaks
    // ~3 processes — each spawn hammers macOS syspolicyd for signature
    // verification of the unsigned NPM codex binary, eventually pegging the
    // daemon at 80%+ CPU and stalling every subsequent fork/exec on the box.
    // Node's execFile { timeout: ... } only signals the immediate child
    // (the shell) and leaves grandchildren orphaned; coreutils `timeout`
    // signals the whole process group by default.
    const requestScript = [
      "cat <<'EOF' | codex app-server",
      initializeRequest,
      initializedNotification,
      modelListRequest,
      "EOF"
    ].join("\n");

    const { stdout } = await this.execFileFn(
      "timeout",
      ["--kill-after=3", "15", "/bin/sh", "-lc", requestScript],
      {
        env: process.env,
        timeout: CODEX_APP_SERVER_NODE_TIMEOUT_MS,
        killSignal: "SIGTERM"
      }
    );

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

  private async resolveCommandPath(command: string): Promise<string> {
    if (!isShellSafeCommand(command)) {
      throw new Error(`unsafe command name: ${command}`);
    }
    const { stdout } = await this.execFileFn(
      "/bin/sh",
      ["-lc", `command -v ${command}`],
      { timeout: CLI_DISCOVERY_TIMEOUT_MS }
    );
    const firstLine = stdout.trim().split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
    if (!firstLine) {
      throw new Error(`${command} CLI was not found on PATH`);
    }
    return this.realpathFn(firstLine);
  }

  private async listClaudeModelsViaCli(): Promise<ProviderModel[]> {
    const cliPath = await this.resolveCommandPath("claude");
    const { stdout } = await this.execFileFn(
      "/bin/sh",
      [
        "-lc",
        [
          "strings \"$1\"",
          "grep -Eo 'claude-(opus|sonnet|haiku)-[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]|claude-(opus|sonnet|haiku)-[A-Za-z0-9]'",
          "sort -u"
        ].join(" | "),
        "sh",
        cliPath
      ],
      { timeout: CLI_DISCOVERY_TIMEOUT_MS, maxBuffer: 512 * 1024 }
    );
    const ids = parseClaudeCliModelIds(stdout);
    if (ids.length === 0) {
      throw new Error("Claude CLI did not expose model identifiers");
    }
    return modelRecordsFromIds(ids);
  }

  private async packageRootForCliFile(cliPath: string, expectedName: string): Promise<string> {
    let dir = path.dirname(cliPath);
    let candidate: string | null = null;
    for (let i = 0; i < 6; i += 1) {
      try {
        const raw = await this.readFileFn(path.join(dir, "package.json"), "utf8");
        const parsed = JSON.parse(raw) as { name?: unknown };
        if (parsed.name === expectedName) candidate = dir;
      } catch {
        // keep walking up
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return candidate ?? path.dirname(cliPath);
  }

  private async listGeminiModelsViaCli(): Promise<ProviderModel[]> {
    const cliPath = await this.resolveCommandPath("gemini");
    const packageRoot = await this.packageRootForCliFile(cliPath, "@google/gemini-cli");
    const entries = await this.readdirFn(packageRoot, { recursive: true });
    const modelSourceFiles = entries.filter((entry) => {
      if (!(entry.endsWith(".js") || entry.endsWith(".d.ts"))) return false;
      if (entry.includes("node_modules") && !entry.includes(`node_modules${path.sep}@google${path.sep}gemini-cli-core${path.sep}`)) {
        return false;
      }
      return true;
    });
    if (modelSourceFiles.length === 0) {
      throw new Error("Gemini CLI package contains no model source files");
    }

    const ids = new Set<string>();
    await Promise.all(modelSourceFiles.map(async (entry) => {
      const raw = await this.readFileFn(path.join(packageRoot, entry), "utf8");
      for (const id of parseGeminiCliModelIds(raw)) ids.add(id);
    }));

    if (ids.size === 0) {
      throw new Error("Gemini CLI bundle did not expose model identifiers");
    }
    return modelRecordsFromIds(Array.from(ids));
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
    try {
      return await this.listClaudeModelsViaCli();
    } catch (cliError) {
      if (!this.anthropicApiKey) {
        const cliMessage = cliError instanceof Error ? cliError.message : String(cliError);
        throw new Error(`Claude CLI model catalog unavailable: ${cliMessage}`);
      }
    }

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
    try {
      return await this.listGeminiModelsViaCli();
    } catch (cliError) {
      if (!this.geminiApiKey) {
        const cliMessage = cliError instanceof Error ? cliError.message : String(cliError);
        throw new Error(`Gemini CLI model catalog unavailable: ${cliMessage}`);
      }
    }

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

  private async listAntigravityModels(): Promise<ProviderModel[]> {
    await this.resolveCommandPath("agy");
    let stdout = "";
    let directError: unknown;
    try {
      const direct = await this.execFileFn(
        "agy",
        ["models"],
        { timeout: CLI_DISCOVERY_TIMEOUT_MS, maxBuffer: 512 * 1024 }
      );
      stdout = direct.stdout;
    } catch (error) {
      directError = error;
    }
    const models = parseAntigravityModels(stdout);
    if (models.length > 0) {
      return models;
    }

    try {
      const expectScript = [
        "set timeout 25",
        "spawn agy models",
        "expect eof"
      ].join("\n");
      const fallback = await this.execFileFn(
        "/usr/bin/expect",
        ["-c", expectScript],
        { timeout: 30_000, maxBuffer: 512 * 1024, env: process.env }
      );
      const ptyModels = parseAntigravityModels(fallback.stdout);
      if (ptyModels.length > 0) {
        return ptyModels;
      }
    } catch (fallbackError) {
      const directMessage = directError instanceof Error ? directError.message : String(directError ?? "empty output");
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`Antigravity CLI model catalog unavailable: ${directMessage}; PTY fallback failed: ${fallbackMessage}`);
    }

    throw new Error("Antigravity CLI returned no selectable models");
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
