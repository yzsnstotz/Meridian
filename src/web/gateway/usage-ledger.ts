import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ProviderId } from "./login";

export type GatewayUsageSurface =
  | "openai-chat"
  | "openai-chat-stream"
  | "anthropic-messages"
  | "anthropic-messages-stream"
  | "direct-test";

export interface GatewayUsageRecordInput {
  provider: ProviderId;
  model: string;
  surface: GatewayUsageSurface;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  timestamp?: string;
}

export interface GatewayUsageRecord {
  id: string;
  timestamp: string;
  provider: ProviderId;
  model: string;
  surface: GatewayUsageSurface;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
}

export interface GatewayUsageSummary {
  provider: ProviderId;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  averageDurationMs: number;
  latestAt: string;
}

export interface GatewayUsageSnapshot {
  summary: GatewayUsageSummary[];
  log: GatewayUsageRecord[];
}

export interface GatewayUsageSnapshotOptions {
  limit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerId(value: unknown): ProviderId | undefined {
  return value === "claude" || value === "codex" || value === "gemini" ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function normalizedDuration(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function surface(value: unknown): GatewayUsageSurface | undefined {
  return value === "openai-chat" ||
    value === "openai-chat-stream" ||
    value === "anthropic-messages" ||
    value === "anthropic-messages-stream" ||
    value === "direct-test"
    ? value
    : undefined;
}

function toRecord(input: GatewayUsageRecordInput): GatewayUsageRecord {
  const promptTokens = tokenCount(input.promptTokens);
  const completionTokens = tokenCount(input.completionTokens);
  return {
    id: `gwusage_${randomUUID()}`,
    timestamp: input.timestamp ?? new Date().toISOString(),
    provider: input.provider,
    model: input.model.trim() || input.provider,
    surface: input.surface,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    durationMs: normalizedDuration(input.durationMs)
  };
}

function parseRecord(value: unknown): GatewayUsageRecord | null {
  if (!isRecord(value)) return null;
  const provider = providerId(value.provider);
  const model = text(value.model);
  const rowSurface = surface(value.surface);
  const timestamp = text(value.timestamp);
  const id = text(value.id);
  if (!provider || !model || !rowSurface || !timestamp || !id) return null;
  const promptTokens = tokenCount(value.promptTokens);
  const completionTokens = tokenCount(value.completionTokens);
  const totalTokens = tokenCount(value.totalTokens) || promptTokens + completionTokens;
  return {
    id,
    timestamp,
    provider,
    model,
    surface: rowSurface,
    promptTokens,
    completionTokens,
    totalTokens,
    durationMs: normalizedDuration(value.durationMs)
  };
}

function sortNewestFirst(records: GatewayUsageRecord[]): GatewayUsageRecord[] {
  return [...records].sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

function summarize(records: GatewayUsageRecord[]): GatewayUsageSummary[] {
  const byProvider = new Map<ProviderId, GatewayUsageRecord[]>();
  for (const record of records) {
    byProvider.set(record.provider, [...(byProvider.get(record.provider) ?? []), record]);
  }

  return Array.from(byProvider.entries())
    .map(([provider, rows]) => {
      const durationTotal = rows.reduce((sum, row) => sum + row.durationMs, 0);
      return {
        provider,
        requests: rows.length,
        promptTokens: rows.reduce((sum, row) => sum + row.promptTokens, 0),
        completionTokens: rows.reduce((sum, row) => sum + row.completionTokens, 0),
        totalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
        averageDurationMs: Math.round(durationTotal / rows.length),
        latestAt: sortNewestFirst(rows)[0]?.timestamp ?? ""
      };
    });
}

export class GatewayUsageLedger {
  private readonly records: GatewayUsageRecord[] = [];

  constructor(private readonly ledgerPath: string) {
    this.load();
  }

  async record(input: GatewayUsageRecordInput): Promise<GatewayUsageRecord> {
    const record = toRecord(input);
    this.records.push(record);
    await fs.promises.mkdir(path.dirname(this.ledgerPath), { recursive: true });
    await fs.promises.appendFile(this.ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  snapshot(options: GatewayUsageSnapshotOptions = {}): GatewayUsageSnapshot {
    const limit = Math.max(1, Math.min(1000, Math.round(options.limit ?? 200)));
    return {
      summary: summarize(this.records),
      log: sortNewestFirst(this.records).slice(0, limit)
    };
  }

  private load(): void {
    if (!fs.existsSync(this.ledgerPath)) return;
    try {
      const content = fs.readFileSync(this.ledgerPath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const record = parseRecord(JSON.parse(trimmed) as unknown);
        if (record) this.records.push(record);
      }
    } catch {
      // Keep the Gateway usable even if the local JSONL file is hand-edited.
    }
  }
}
