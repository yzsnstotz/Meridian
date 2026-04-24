import * as fs from "node:fs/promises";
import path from "node:path";

import { LifecycleStore } from "../../roles/agent-dispatcher/lifecycle-store";
import type { DispatchThreadStateV2 } from "../../types";
import type { ToolDefinition, ToolResult } from "../registry";

const DEFAULT_STALE_THRESHOLD_MINUTES = 30;

export interface DispatchPlanWorkerRow {
  status: string;
  batch: string;
  worker_id: string;
  task: string | null;
  model: string | null;
  depends_on: string[];
  prds_to_attach: string | null;
  notes: string | null;
}

export interface DispatchStatusWorker extends DispatchPlanWorkerRow {
  lifecycle_status: string | null;
  thread_id: string | null;
  last_seen_at: string | null;
  retry_count: number;
  failure_reason: string | null;
  stale: boolean;
  stale_label: string | null;
  stale_duration_minutes: number | null;
  stale_duration_human: string | null;
}

export interface DispatchStatusReport extends Record<string, unknown> {
  plan: string;
  dispatch_threads: string;
  generated_at: string;
  stale_threshold_minutes: number;
  workers: DispatchStatusWorker[];
  summary: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    skipped: number;
    stale: number;
  };
}

const dispatchStatusTool: ToolDefinition = {
  name: "dispatch-status",
  description: "Show dispatch worker statuses and flag stale running workers from dispatch_threads.json",
  params: {
    plan: {
      type: "string",
      required: true,
      description: "Absolute path to the dispatch_plan.md file"
    },
    stale_threshold: {
      type: "string",
      required: false,
      description: "Minutes before a running worker is marked stale (default 30)"
    }
  },
  async execute(params: Record<string, string>): Promise<ToolResult> {
    const planPath = requireParam(params.plan);
    if (!planPath) {
      return {
        ok: false,
        error: "Missing required parameter: plan"
      };
    }

    const staleThreshold = parseStaleThreshold(params.stale_threshold);
    if (staleThreshold === null) {
      return {
        ok: false,
        error: `Invalid stale_threshold: ${params.stale_threshold}`
      };
    }

    try {
      return {
        ok: true,
        data: await buildDispatchStatusReport(planPath, staleThreshold)
      };
    } catch (error) {
      return {
        ok: false,
        error: asError(error).message
      };
    }
  }
};

export default dispatchStatusTool;

export async function buildDispatchStatusReport(
  planPath: string,
  staleThresholdMinutes = DEFAULT_STALE_THRESHOLD_MINUTES
): Promise<DispatchStatusReport> {
  const planMarkdown = await fs.readFile(planPath, "utf8");
  const rows = parseDispatchPlanRows(planMarkdown);
  if (rows.length === 0) {
    throw new Error(`No dispatch workers found in dispatch plan: ${planPath}`);
  }

  const lifecycleState = new LifecycleStore(resolveDispatchThreadsPath(planPath)).load();
  const generatedAt = new Date().toISOString();
  const workers = rows.map((row) => buildWorkerStatus(row, lifecycleState, staleThresholdMinutes, generatedAt));

  return {
    plan: planPath,
    dispatch_threads: resolveDispatchThreadsPath(planPath),
    generated_at: generatedAt,
    stale_threshold_minutes: staleThresholdMinutes,
    workers,
    summary: summarizeWorkers(workers)
  };
}

export function parseDispatchPlanRows(markdown: string): DispatchPlanWorkerRow[] {
  const lines = markdown.split(/\r?\n/);

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = parseTableRow(lines[index]);
    if (!headerCells) {
      continue;
    }

    const normalizedHeaders = headerCells.map(normalizeHeaderCell);
    const statusColumn = normalizedHeaders.indexOf("status");
    const batchColumn = normalizedHeaders.indexOf("batch");
    const workerColumn = normalizedHeaders.indexOf("worker");
    if (statusColumn === -1 || batchColumn === -1 || workerColumn === -1) {
      continue;
    }

    const separatorCells = parseTableRow(lines[index + 1]);
    if (!separatorCells || separatorCells.length !== headerCells.length || !isSeparatorRow(separatorCells)) {
      continue;
    }

    const taskColumn = findNormalizedHeaderIndex(normalizedHeaders, ["task", "function_group", "headline", "action"]);
    const modelColumn = findNormalizedHeaderIndex(normalizedHeaders, ["model", "agent", "model_tier"]);
    const dependsOnColumn = findNormalizedHeaderIndex(normalizedHeaders, ["depends_on", "depends", "dependencies"]);
    const prdsColumn = findNormalizedHeaderIndex(normalizedHeaders, ["prds_to_attach", "prds", "prd"]);
    const notesColumn = findNormalizedHeaderIndex(normalizedHeaders, ["notes", "note"]);
    const rows: DispatchPlanWorkerRow[] = [];

    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowCells = parseTableRow(lines[rowIndex]);
      if (!rowCells || rowCells.length !== headerCells.length) {
        break;
      }

      rows.push({
        status: rowCells[statusColumn],
        batch: rowCells[batchColumn],
        worker_id: rowCells[workerColumn],
        task: readOptionalCell(rowCells, taskColumn),
        model: readOptionalCell(rowCells, modelColumn),
        depends_on: parseDependsOn(readOptionalCell(rowCells, dependsOnColumn)),
        prds_to_attach: readOptionalCell(rowCells, prdsColumn),
        notes: readOptionalCell(rowCells, notesColumn)
      });
    }

    return rows;
  }

  return [];
}

function buildWorkerStatus(
  row: DispatchPlanWorkerRow,
  lifecycleState: DispatchThreadStateV2,
  staleThresholdMinutes: number,
  generatedAt: string
): DispatchStatusWorker {
  const workerState = lifecycleState.workers[row.worker_id];
  const staleDurationMs = getStaleDurationMs(row.status, workerState?.last_seen_at, staleThresholdMinutes, generatedAt);

  return {
    ...row,
    lifecycle_status: workerState?.status ?? null,
    thread_id: workerState?.thread_id ?? null,
    last_seen_at: workerState?.last_seen_at ?? null,
    retry_count: workerState?.retry_count ?? 0,
    failure_reason: extractFailureReason(workerState),
    stale: staleDurationMs !== null,
    stale_label: staleDurationMs === null ? null : "⚠️ STALE",
    stale_duration_minutes: staleDurationMs === null ? null : Math.floor(staleDurationMs / 60_000),
    stale_duration_human: staleDurationMs === null ? null : formatDuration(staleDurationMs)
  };
}

function summarizeWorkers(workers: DispatchStatusWorker[]): DispatchStatusReport["summary"] {
  return workers.reduce<DispatchStatusReport["summary"]>(
    (summary, worker) => {
      summary.total += 1;

      switch (categorizeStatus(worker.lifecycle_status ?? worker.status)) {
        case "pending":
          summary.pending += 1;
          break;
        case "running":
          summary.running += 1;
          break;
        case "completed":
          summary.completed += 1;
          break;
        case "skipped":
          summary.skipped += 1;
          break;
        case "failed":
          summary.failed += 1;
          break;
      }

      if (worker.stale) {
        summary.stale += 1;
      }

      return summary;
    },
    {
      total: 0,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      stale: 0
    }
  );
}

function extractFailureReason(workerState: DispatchThreadStateV2["workers"][string] | undefined): string | null {
  if (!workerState || workerState.status !== "failed") {
    return null;
  }

  const hubResult = workerState.hub_result;
  if (!hubResult) {
    return null;
  }

  const content = hubResult.content ?? "";
  if (content.length === 0) {
    return hubResult.status === "error" ? "hub returned error (no content)" : null;
  }

  // Try to extract a concise error message from the content
  const errorMatch = content.match(/"message"\s*:\s*"([^"]{1,200})"/);
  if (errorMatch) {
    return errorMatch[1];
  }

  // Truncate raw content to a useful summary
  const MAX_REASON_LENGTH = 200;
  return content.length > MAX_REASON_LENGTH ? `${content.slice(0, MAX_REASON_LENGTH)}…` : content;
}

function categorizeStatus(status: string): "pending" | "running" | "completed" | "failed" | "skipped" {
  if (status === "⬜" || status === "pending") {
    return "pending";
  }

  if (status === "🔄" || status === "running" || status === "awaiting_validation" || status === "fix_requested") {
    return "running";
  }

  if (status === "✅" || status === "completed") {
    return "completed";
  }

  if (status === "⛔ SKIPPED" || status === "skipped") {
    return "skipped";
  }

  return "failed";
}

function getStaleDurationMs(
  status: string,
  lastSeenAt: string | undefined,
  staleThresholdMinutes: number,
  generatedAt: string
): number | null {
  if (status !== "🔄" || !lastSeenAt) {
    return null;
  }

  const nowMs = Date.parse(generatedAt);
  const lastSeenMs = Date.parse(lastSeenAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastSeenMs)) {
    return null;
  }

  const durationMs = Math.max(0, nowMs - lastSeenMs);
  return durationMs >= staleThresholdMinutes * 60_000 ? durationMs : null;
}

function formatDuration(durationMs: number): string {
  const totalMinutes = Math.floor(durationMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${totalMinutes}m`;
  }

  if (minutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${minutes}m`;
}

function parseStaleThreshold(value: string | undefined): number | null {
  const normalized = requireParam(value);
  if (!normalized) {
    return DEFAULT_STALE_THRESHOLD_MINUTES;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

function resolveDispatchThreadsPath(planPath: string): string {
  return path.join(path.dirname(planPath), "dispatch_threads.json");
}

function readOptionalCell(cells: string[], index: number): string | null {
  if (index < 0 || index >= cells.length) {
    return null;
  }

  const value = cells[index]?.trim();
  if (!value || value === "—") {
    return null;
  }

  return value;
}

function findNormalizedHeaderIndex(normalizedHeaders: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const index = normalizedHeaders.indexOf(candidate);
    if (index !== -1) {
      return index;
    }
  }

  return -1;
}

function normalizeHeaderCell(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseDependsOn(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== "—");
}

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) {
    return null;
  }

  const withoutLeadingPipe = trimmed.slice(1);
  const normalized = withoutLeadingPipe.endsWith("|")
    ? withoutLeadingPipe.slice(0, -1)
    : withoutLeadingPipe;

  return normalized.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function requireParam(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
