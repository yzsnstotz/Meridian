import fs from "node:fs";
import path from "node:path";

import type { AgentType, HubResult } from "../types";

export type UsageScopeKind =
  | "tenant"
  | "user"
  | "mailbox"
  | "role"
  | "job"
  | "provider"
  | "model"
  | "campaign";

export interface UsageScope {
  readonly kind: UsageScopeKind;
  readonly id: string;
}

export interface UsageMeter {
  readonly id: string;
  readonly tenantId: string;
  readonly scope: UsageScope;
  readonly provider?: AgentType;
  readonly model?: string;
  readonly inputTokens: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
  readonly totalTokens: number;
  readonly messagesProcessed: number;
  readonly emailsSent: number;
  readonly measuredAt: string;
  readonly jobId: string;
  readonly threadId: string;
  readonly credentialId?: string;
  readonly roleId?: string;
  readonly userId?: string;
  readonly mailboxId?: string;
  readonly campaignId?: string;
}

export interface RuntimeQuotaBalance {
  readonly quota: unknown;
  readonly remaining: number;
  readonly exhausted: boolean;
}

export interface UsageSnapshot {
  readonly scope: UsageScope;
  readonly meters: readonly UsageMeter[];
  readonly total?: UsageMeter;
  readonly quotas: readonly unknown[];
  readonly quotaBalances: readonly RuntimeQuotaBalance[];
}

export interface UsageRunContext {
  readonly content: string;
  readonly tenantId?: string;
  readonly userId?: string;
  readonly mailboxId?: string;
  readonly roleId?: string;
  readonly campaignId?: string;
}

interface NormalizedUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function tokenCount(value: unknown): number | undefined {
  const numberValue = finiteNumber(value);
  if (numberValue === undefined) {
    return undefined;
  }
  return Math.max(0, Math.round(numberValue));
}

function pickToken(record: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = tokenCount(record[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return 0;
}

function sumTokens(record: Record<string, unknown>, keys: readonly string[]): number {
  return keys.reduce((total, key) => total + (tokenCount(record[key]) ?? 0), 0);
}

function normalizeUsage(raw: unknown): NormalizedUsage | null {
  if (!isRecord(raw)) {
    return null;
  }

  const inputTokens = pickToken(raw, ["input_tokens", "prompt_tokens", "input"]);
  const cachedInputTokens =
    sumTokens(raw, ["cached_input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) ||
    pickToken(raw, ["cached"]);
  const outputTokens = pickToken(raw, ["output_tokens", "completion_tokens", "output"]);
  const reasoningTokens = pickToken(raw, ["reasoning_output_tokens", "reasoning_tokens"]);
  const explicitTotal = pickToken(raw, ["total_tokens", "total"]);
  const totalTokens = explicitTotal || inputTokens + outputTokens + reasoningTokens;

  if (inputTokens === 0 && cachedInputTokens === 0 && outputTokens === 0 && reasoningTokens === 0 && totalTokens === 0) {
    return null;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens
  };
}

function extractTextIdentifier(content: string, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const jsonMatch = content.match(new RegExp(`"${key}"\\s*:\\s*"([^"]{1,160})"`));
    if (jsonMatch?.[1]) {
      return jsonMatch[1];
    }

    const kvMatch = content.match(new RegExp(`\\b${key}\\b\\s*[=:]\\s*([A-Za-z0-9_.:@/-]{1,160})`));
    if (kvMatch?.[1]) {
      return kvMatch[1];
    }
  }

  return undefined;
}

function deriveRunContext(context: UsageRunContext): Required<Pick<UsageRunContext, "tenantId">> &
  Omit<UsageRunContext, "tenantId" | "content"> {
  const content = context.content;
  const tenantId =
    context.tenantId ??
    extractTextIdentifier(content, ["tenantId", "tenant_id", "tenant"]) ??
    "default";

  return {
    tenantId,
    userId: context.userId ?? extractTextIdentifier(content, ["userId", "user_id"]),
    mailboxId: context.mailboxId ?? extractTextIdentifier(content, ["mailboxId", "mailbox_id", "accountId", "account_id"]),
    roleId: context.roleId ?? extractTextIdentifier(content, ["roleType", "role_type", "roleId", "role_id"]),
    campaignId: context.campaignId ?? extractTextIdentifier(content, ["campaignId", "campaign_id"])
  };
}

function latestTimestamp(meters: readonly UsageMeter[]): string {
  return meters.reduce((latest, meter) => (meter.measuredAt > latest ? meter.measuredAt : latest), meters[0]?.measuredAt ?? new Date(0).toISOString());
}

function sumMeters(scope: UsageScope, meters: readonly UsageMeter[]): UsageMeter | undefined {
  const first = meters[0];
  if (!first) {
    return undefined;
  }

  const provider = meters.every((meter) => meter.provider === first.provider) ? first.provider : undefined;
  const model = meters.every((meter) => meter.model === first.model) ? first.model : undefined;
  const credentialId = meters.every((meter) => meter.credentialId === first.credentialId) ? first.credentialId : undefined;

  return {
    id: `usage:${scope.kind}:${scope.id}`,
    tenantId: scope.kind === "tenant" ? scope.id : first.tenantId,
    scope,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    inputTokens: meters.reduce((total, meter) => total + meter.inputTokens, 0),
    cachedInputTokens: meters.reduce((total, meter) => total + (meter.cachedInputTokens ?? 0), 0),
    outputTokens: meters.reduce((total, meter) => total + meter.outputTokens, 0),
    reasoningTokens: meters.reduce((total, meter) => total + (meter.reasoningTokens ?? 0), 0),
    totalTokens: meters.reduce((total, meter) => total + meter.totalTokens, 0),
    messagesProcessed: meters.reduce((total, meter) => total + meter.messagesProcessed, 0),
    emailsSent: meters.reduce((total, meter) => total + meter.emailsSent, 0),
    measuredAt: latestTimestamp(meters),
    jobId: scope.kind === "job" ? scope.id : `usage:${scope.kind}:${scope.id}`,
    threadId: first.threadId,
    ...(credentialId !== undefined ? { credentialId } : {}),
    ...(scope.kind === "role" ? { roleId: scope.id } : {}),
    ...(scope.kind === "user" ? { userId: scope.id } : {}),
    ...(scope.kind === "mailbox" ? { mailboxId: scope.id } : {}),
    ...(scope.kind === "campaign" ? { campaignId: scope.id } : {})
  };
}

function meterMatchesScope(meter: UsageMeter, scope: UsageScope): boolean {
  switch (scope.kind) {
    case "tenant":
      return meter.tenantId === scope.id;
    case "provider":
      return meter.provider === scope.id;
    case "model":
      return meter.model === scope.id;
    case "role":
      return meter.roleId === scope.id || (meter.scope.kind === scope.kind && meter.scope.id === scope.id);
    case "user":
      return meter.userId === scope.id || (meter.scope.kind === scope.kind && meter.scope.id === scope.id);
    case "mailbox":
      return meter.mailboxId === scope.id || (meter.scope.kind === scope.kind && meter.scope.id === scope.id);
    case "campaign":
      return meter.campaignId === scope.id || (meter.scope.kind === scope.kind && meter.scope.id === scope.id);
    case "job":
      return meter.jobId === scope.id || (meter.scope.kind === scope.kind && meter.scope.id === scope.id);
  }
}

export class UsageLedger {
  private readonly meters: UsageMeter[] = [];

  constructor(private readonly ledgerPath: string) {
    this.loadExistingMeters();
  }

  async recordRun(result: HubResult, context: UsageRunContext): Promise<UsageMeter | null> {
    const normalized = normalizeUsage(result.usage);
    if (!normalized) {
      return null;
    }

    const derivedContext = deriveRunContext(context);
    const measuredAt = result.timestamp;
    const jobId = result.trace_id;
    const meter: UsageMeter = {
      id: `usage:job:${jobId}`,
      tenantId: derivedContext.tenantId,
      scope: { kind: "job", id: jobId },
      provider: result.source,
      ...(result.model_id ? { model: result.model_id } : {}),
      inputTokens: normalized.inputTokens,
      cachedInputTokens: normalized.cachedInputTokens,
      outputTokens: normalized.outputTokens,
      reasoningTokens: normalized.reasoningTokens,
      totalTokens: normalized.totalTokens,
      messagesProcessed: 1,
      emailsSent: 0,
      measuredAt,
      jobId,
      threadId: result.thread_id,
      ...(result.credential_id ? { credentialId: result.credential_id } : {}),
      ...(derivedContext.roleId ? { roleId: derivedContext.roleId } : {}),
      ...(derivedContext.userId ? { userId: derivedContext.userId } : {}),
      ...(derivedContext.mailboxId ? { mailboxId: derivedContext.mailboxId } : {}),
      ...(derivedContext.campaignId ? { campaignId: derivedContext.campaignId } : {})
    };

    this.meters.push(meter);
    await fs.promises.mkdir(path.dirname(this.ledgerPath), { recursive: true });
    await fs.promises.appendFile(this.ledgerPath, `${JSON.stringify(meter)}\n`, "utf8");
    return meter;
  }

  snapshot(scope: UsageScope): UsageSnapshot {
    const meters = this.meters.filter((meter) => meterMatchesScope(meter, scope));
    return {
      scope,
      meters,
      total: sumMeters(scope, meters),
      quotas: [],
      quotaBalances: []
    };
  }

  private loadExistingMeters(): void {
    if (!fs.existsSync(this.ledgerPath)) {
      return;
    }

    try {
      const content = fs.readFileSync(this.ledgerPath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const parsed = JSON.parse(trimmed) as unknown;
        if (this.isUsageMeter(parsed)) {
          this.meters.push(parsed);
        }
      }
    } catch {
      // Keep the web server usable even if an operator manually edited the
      // JSONL ledger. New records will continue appending to the same file.
    }
  }

  private isUsageMeter(value: unknown): value is UsageMeter {
    if (!isRecord(value)) {
      return false;
    }
    return (
      nonEmptyString(value.id) !== undefined &&
      nonEmptyString(value.tenantId) !== undefined &&
      isRecord(value.scope) &&
      nonEmptyString(value.scope.id) !== undefined &&
      nonEmptyString(value.scope.kind) !== undefined &&
      tokenCount(value.inputTokens) !== undefined &&
      tokenCount(value.outputTokens) !== undefined &&
      tokenCount(value.totalTokens) !== undefined &&
      nonEmptyString(value.measuredAt) !== undefined
    );
  }
}
