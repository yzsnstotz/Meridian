import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { DispatchWorkerProgress } from "./dispatch-status";

const REGISTRY_FILE_NAME = "progress_registry.json";
const HTTP_TIMEOUT_MS = 1500;

const ProgressSourceFileSchema = z.object({
  kind: z.literal("file"),
  path: z.string().min(1)
});

const ProgressSourceHttpSchema = z.object({
  kind: z.literal("http"),
  url: z.string().min(1)
});

const ProgressSourceSchema = z.union([ProgressSourceFileSchema, ProgressSourceHttpSchema]);

const ProgressRegistryEntrySchema = z.object({
  name: z.string().min(1),
  plan_path_prefix: z.string().min(1),
  default_source: ProgressSourceSchema.optional(),
  workers: z.record(z.string(), ProgressSourceSchema).optional()
});

const ProgressRegistrySchema = z.object({
  version: z.literal(1),
  routine_jobs: z.array(ProgressRegistryEntrySchema)
});

export type ProgressSource = z.infer<typeof ProgressSourceSchema>;
export type ProgressRegistryEntry = z.infer<typeof ProgressRegistryEntrySchema>;
export type ProgressRegistry = z.infer<typeof ProgressRegistrySchema>;

export interface ResolvedProgressSource {
  routineJob: string;
  source: ProgressSource;
}

export async function loadProgressRegistryForPlan(planPath: string): Promise<ProgressRegistry | null> {
  const registryPath = findRegistryFile(planPath);
  if (!registryPath) {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(registryPath, "utf8"));
  } catch {
    return null;
  }

  const parsed = ProgressRegistrySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function resolveProgressSource(
  registry: ProgressRegistry | null,
  planPath: string,
  workerId: string
): ResolvedProgressSource | null {
  if (!registry) {
    return null;
  }

  const entry = matchRoutineJob(registry, planPath);
  if (!entry) {
    return null;
  }

  const override = entry.workers?.[workerId];
  if (override) {
    return { routineJob: entry.name, source: override };
  }

  if (entry.default_source) {
    return { routineJob: entry.name, source: entry.default_source };
  }

  return null;
}

export async function fetchProgressFromSource(
  resolved: ResolvedProgressSource,
  workerId: string,
  scanRunId: string | null
): Promise<DispatchWorkerProgress | null> {
  const { source } = resolved;
  const substituted = substituteSource(source, workerId, scanRunId);

  const payload = substituted.kind === "file"
    ? await readProgressFile(substituted.path)
    : await fetchProgressHttp(substituted.url);

  if (!payload) {
    return null;
  }

  return normalizePayload(payload, substituted, workerId);
}

function findRegistryFile(start: string): string | null {
  let dir = path.dirname(path.resolve(start));
  // Cap at filesystem root to avoid infinite loops on weird paths.
  for (let depth = 0; depth < 64; depth += 1) {
    const candidate = path.join(dir, REGISTRY_FILE_NAME);
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
  return null;
}

function matchRoutineJob(registry: ProgressRegistry, planPath: string): ProgressRegistryEntry | null {
  const resolved = path.resolve(planPath);
  // Prefer the longest matching prefix so nested routine-jobs win over their parent.
  let best: ProgressRegistryEntry | null = null;
  for (const entry of registry.routine_jobs) {
    if (resolved.startsWith(path.resolve(entry.plan_path_prefix))) {
      if (!best || entry.plan_path_prefix.length > best.plan_path_prefix.length) {
        best = entry;
      }
    }
  }
  return best;
}

function substituteSource(source: ProgressSource, workerId: string, scanRunId: string | null): ProgressSource {
  const replace = (value: string): string => value
    .replaceAll("{worker_id}", workerId)
    .replaceAll("{scan_run_id}", scanRunId ?? "");

  if (source.kind === "file") {
    return { kind: "file", path: replace(source.path) };
  }
  return { kind: "http", url: replace(source.url) };
}

async function readProgressFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function fetchProgressHttp(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePayload(
  payload: unknown,
  source: ProgressSource,
  workerId: string
): DispatchWorkerProgress | null {
  if (!isRecord(payload)) {
    return null;
  }

  const sourcePath = source.kind === "file" ? source.path : source.url;

  return {
    progress_path: sourcePath,
    source: "progress_file",
    command: readString(payload.command) ?? workerId,
    scan_run_id: readString(payload.scan_run_id),
    status: readString(payload.status) ?? "unknown",
    total: readNumber(payload.total),
    processed: readNumber(payload.processed),
    success: readNumber(payload.success),
    failed: readNumber(payload.failed),
    skipped: readNumber(payload.skipped),
    skipped_existing: readNumber(payload.skipped_existing),
    remaining: readNumber(payload.remaining),
    started_at: readString(payload.started_at),
    updated_at: readString(payload.updated_at),
    completed_at: readString(payload.completed_at),
    pid: readNumber(payload.pid),
    rate_limit_waits: readNumber(payload.rate_limit_waits),
    last_skill: readLastSkill(payload.last_skill),
    extra: isRecord(payload.extra) ? payload.extra : null
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readLastSkill(value: unknown): { owner: string; slug: string } | null {
  if (!isRecord(value)) {
    return null;
  }
  const owner = readString(value.owner);
  const slug = readString(value.slug);
  return owner && slug ? { owner, slug } : null;
}
