import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ProviderModelCatalogResult } from "../../shared/model-catalog";
import { ProviderModelCatalog } from "../../shared/model-catalog";
import type { ProviderModel } from "../../types";
import { completeAntigravity } from "./antigravity";
import { completeClaude } from "./claude";
import { completeCodex } from "./codex";
import { completeGemini } from "./gemini";
import { normalizeDirectTestError } from "./direct-test";
import type { ProvidersStatus, ProviderId } from "./login";
import type { ChatCompletionRequest, CompletionResult } from "./shared";
import type { GatewayModel, GatewayModelCatalog, GatewayModelList } from "./model-list";
import { ownerForProvider } from "./model-list";

type ProbeCompletion = (req: ChatCompletionRequest) => Promise<CompletionResult>;
type CacheSource = "codex-app-server" | "cli-probe";

interface CachedProviderModels {
  provider: ProviderId;
  refreshedAt: string;
  source: CacheSource;
  models: ProviderModel[];
  candidateCount?: number;
  error?: string;
}

interface ModelCacheFile {
  version: 1;
  refreshedAt: string;
  providers: Partial<Record<ProviderId, CachedProviderModels>>;
}

export type ProviderModelRefreshResult = CachedProviderModels;

export interface ModelRefreshSnapshot {
  refreshedAt: string;
  providers: Partial<Record<ProviderId, ProviderModelRefreshResult>>;
}

export interface GatewayModelRegistryOptions {
  catalog?: GatewayModelCatalog;
  completions?: Partial<Record<ProviderId, ProbeCompletion>>;
  cachePath?: string;
  now?: () => Date;
}

const PROVIDERS: ProviderId[] = ["claude", "codex", "gemini", "antigravity"];
const CLI_PROVIDERS: ProviderId[] = ["claude", "gemini", "antigravity"];
const LABELS: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "ChatGPT",
  gemini: "Gemini",
  antigravity: "Antigravity"
};
const DEFAULT_CACHE_PATH = path.join(os.homedir(), ".meridian-gateway", "models-cache.json");
const PROBE_PROMPT = "Reply with exactly OK.";

const DEFAULT_COMPLETIONS: Record<ProviderId, ProbeCompletion> = {
  antigravity: completeAntigravity,
  claude: completeClaude,
  codex: completeCodex,
  gemini: completeGemini
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProvider(value: string): value is ProviderId {
  return value === "claude" || value === "codex" || value === "gemini" || value === "antigravity";
}

function dedupeModels(models: ProviderModel[]): ProviderModel[] {
  const deduped = new Map<string, ProviderModel>();
  for (const model of models) {
    if (!model.id) continue;
    deduped.set(model.id, model);
  }
  return Array.from(deduped.values()).sort((left, right) => left.label.localeCompare(right.label));
}

function toProviderModels(value: unknown): ProviderModel[] {
  if (!Array.isArray(value)) return [];
  return dedupeModels(value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const label = typeof entry.label === "string" && entry.label.trim().length > 0 ? entry.label.trim() : id;
    return id ? [{ id, label }] : [];
  }));
}

function parseCache(raw: string): ModelCacheFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.providers)) {
    return null;
  }
  const providers: Partial<Record<ProviderId, CachedProviderModels>> = {};
  for (const [key, value] of Object.entries(parsed.providers)) {
    if (!isProvider(key) || !isRecord(value)) continue;
    const refreshedAt = typeof value.refreshedAt === "string" ? value.refreshedAt : "";
    const source = value.source === "codex-app-server" || value.source === "cli-probe" ? value.source : undefined;
    if (!refreshedAt || !source) continue;
    providers[key] = {
      provider: key,
      refreshedAt,
      source,
      models: toProviderModels(value.models),
      candidateCount: typeof value.candidateCount === "number" ? value.candidateCount : undefined,
      error: typeof value.error === "string" && value.error.trim().length > 0 ? value.error.trim() : undefined
    };
  }
  return {
    version: 1,
    refreshedAt: typeof parsed.refreshedAt === "string" ? parsed.refreshedAt : "",
    providers
  };
}

function modelToGateway(provider: ProviderId, model: ProviderModel): GatewayModel {
  return {
    id: model.id,
    object: "model",
    owned_by: ownerForProvider(provider)
  };
}

function sortGatewayModels(models: GatewayModel[]): GatewayModel[] {
  return models.sort((left, right) => {
    const ownerCompare = left.owned_by.localeCompare(right.owned_by);
    return ownerCompare === 0 ? left.id.localeCompare(right.id) : ownerCompare;
  });
}

function noVerifiedModelsMessage(provider: ProviderId): string {
  return `Refresh models to verify currently available ${LABELS[provider]} models for this OAuth account.`;
}

function normalizeCatalogError(provider: ProviderId, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/No API key configured for provider=(claude|gemini|antigravity)/i.test(message)) {
    return `${LABELS[provider]} OAuth is connected, but the local CLI did not expose model candidates.`;
  }
  return message;
}

function shouldStopProviderRefresh(provider: ProviderId, message: string): boolean {
  return provider === "gemini" && /IneligibleTierError|UNSUPPORTED_CLIENT|migrate to the Antigravity/i.test(message);
}

function providerSnapshotFromCache(cache: ModelCacheFile | null, provider: ProviderId): CachedProviderModels | undefined {
  return cache?.providers?.[provider];
}

export class GatewayModelRegistry {
  private readonly catalog: GatewayModelCatalog;
  private readonly completions: Record<ProviderId, ProbeCompletion>;
  private readonly cachePath: string;
  private readonly now: () => Date;

  constructor(options: GatewayModelRegistryOptions = {}) {
    this.catalog = options.catalog ?? new ProviderModelCatalog();
    this.completions = {
      ...DEFAULT_COMPLETIONS,
      ...options.completions
    };
    this.cachePath = options.cachePath ?? DEFAULT_CACHE_PATH;
    this.now = options.now ?? (() => new Date());
  }

  async list(status: ProvidersStatus): Promise<GatewayModelList> {
    const cache = await this.readCache();
    const data: GatewayModel[] = [];
    const errors: Partial<Record<ProviderId, string>> = {};
    let refreshedAt = cache?.refreshedAt;

    for (const provider of PROVIDERS) {
      if (!status[provider]?.connected) continue;
      if (provider === "codex") {
        await this.addCodexModels(data, errors, cache);
        continue;
      }

      const cached = providerSnapshotFromCache(cache, provider);
      if (!cached) {
        errors[provider] = noVerifiedModelsMessage(provider);
        continue;
      }
      refreshedAt = cached.refreshedAt;
      if (cached.models.length > 0) {
        data.push(...cached.models.map((model) => modelToGateway(provider, model)));
      }
      if (cached.error) {
        errors[provider] = cached.error;
      } else if (cached.models.length === 0) {
        errors[provider] = noVerifiedModelsMessage(provider);
      }
    }

    const result: GatewayModelList = { object: "list", data: sortGatewayModels(data) };
    if (Object.keys(errors).length > 0) result.errors = errors;
    if (refreshedAt) result.refreshedAt = refreshedAt;
    return result;
  }

  async refresh(status: ProvidersStatus): Promise<ModelRefreshSnapshot> {
    const existing = await this.readCache();
    const refreshedAt = this.now().toISOString();
    const providers: Partial<Record<ProviderId, CachedProviderModels>> = {
      ...(existing?.providers ?? {})
    };

    for (const provider of PROVIDERS) {
      if (!status[provider]?.connected) {
        delete providers[provider];
        continue;
      }
      providers[provider] = provider === "codex"
        ? await this.refreshCodexProvider(provider, refreshedAt)
        : await this.refreshCliProvider(provider, refreshedAt);
    }

    const cache: ModelCacheFile = { version: 1, refreshedAt, providers };
    await this.writeCache(cache);
    return {
      refreshedAt,
      providers
    };
  }

  private async addCodexModels(
    data: GatewayModel[],
    errors: Partial<Record<ProviderId, string>>,
    cache: ModelCacheFile | null
  ): Promise<void> {
    try {
      const result = await this.catalog.listModels("codex");
      data.push(...result.models.map((model) => modelToGateway("codex", model)));
    } catch (error) {
      const cached = providerSnapshotFromCache(cache, "codex");
      if (cached?.models.length) {
        data.push(...cached.models.map((model) => modelToGateway("codex", model)));
      }
      errors.codex = normalizeCatalogError("codex", error);
    }
  }

  private async refreshCodexProvider(provider: ProviderId, refreshedAt: string): Promise<CachedProviderModels> {
    try {
      const result = await this.catalog.listModels(provider);
      return {
        provider,
        refreshedAt,
        source: "codex-app-server",
        models: dedupeModels(result.models),
        candidateCount: result.models.length
      };
    } catch (error) {
      return {
        provider,
        refreshedAt,
        source: "codex-app-server",
        models: [],
        candidateCount: 0,
        error: normalizeCatalogError(provider, error)
      };
    }
  }

  private async refreshCliProvider(provider: ProviderId, refreshedAt: string): Promise<CachedProviderModels> {
    if (!CLI_PROVIDERS.includes(provider)) {
      return this.refreshCodexProvider(provider, refreshedAt);
    }

    let candidates: ProviderModelCatalogResult;
    try {
      candidates = await this.catalog.listModels(provider);
    } catch (error) {
      return {
        provider,
        refreshedAt,
        source: "cli-probe",
        models: [],
        candidateCount: 0,
        error: normalizeCatalogError(provider, error)
      };
    }

    const models: ProviderModel[] = [];
    const failures: string[] = [];
    for (const candidate of dedupeModels(candidates.models)) {
      const result = await this.probeModel(provider, candidate);
      if (result.ok) {
        models.push(candidate);
        continue;
      }
      failures.push(result.error);
      if (shouldStopProviderRefresh(provider, result.error)) break;
    }

    const error = models.length === 0
      ? (failures[0] ?? noVerifiedModelsMessage(provider))
      : undefined;
    return {
      provider,
      refreshedAt,
      source: "cli-probe",
      models: dedupeModels(models),
      candidateCount: candidates.models.length,
      error
    };
  }

  private async probeModel(provider: ProviderId, model: ProviderModel): Promise<{ ok: true } | { ok: false; error: string }> {
    const request: ChatCompletionRequest = {
      model: model.id,
      messages: [{ role: "user", content: PROBE_PROMPT }],
      max_tokens: 8,
      temperature: 0
    };
    try {
      const result = await this.completions[provider](request);
      if (result.isError) {
        return {
          ok: false,
          error: normalizeDirectTestError(provider, result.errorMessage || "Provider CLI returned an error.", result.model || model.id)
        };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: normalizeDirectTestError(provider, error instanceof Error ? error.message : String(error), model.id)
      };
    }
  }

  private async readCache(): Promise<ModelCacheFile | null> {
    try {
      return parseCache(await fs.readFile(this.cachePath, "utf8"));
    } catch {
      return null;
    }
  }

  private async writeCache(cache: ModelCacheFile): Promise<void> {
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.cachePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmpPath, this.cachePath);
  }
}
