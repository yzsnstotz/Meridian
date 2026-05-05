import * as fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  LifecycleStore,
  hubResultContainsBlockSignal,
  hubResultContainsFailureSignal,
  isPmResolverHubResult
} from "../../roles/agent-dispatcher/lifecycle-store";
import type { DispatchThreadStateV2, DispatchWorkerState, HubResult, PmResolverLifecycleState } from "../../types";
import type { ToolDefinition, ToolResult } from "../registry";
import {
  fetchProgressFromSource,
  loadProgressRegistryForPlan,
  resolveProgressSource,
  type ProgressRegistry
} from "./progress-registry";

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

export type DispatchActiveOwnerKind = "worker" | "validator" | "pm_resolver";

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
  progress: DispatchWorkerProgress | null;
  // The thread that is currently doing work for this row, plus its kind
  // (worker / validator / pm_resolver). Lets the GUI/CLI surface "who is
  // actually running" instead of forcing operators to guess from the
  // worker thread alone — validators and PM resolvers run in separate
  // threads and otherwise stay invisible on the main task bar.
  active_owner_kind: DispatchActiveOwnerKind | null;
  active_owner_thread_id: string | null;
}

export interface DispatchWorkerProgress {
  progress_path: string;
  source: "progress_file" | "fallback";
  command: string;
  scan_run_id: string | null;
  status: string;
  total: number | null;
  processed: number | null;
  success: number | null;
  failed: number | null;
  skipped: number | null;
  skipped_existing: number | null;
  remaining: number | null;
  started_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  pid: number | null;
  rate_limit_waits: number | null;
  last_skill: { owner: string; slug: string } | null;
  extra?: Record<string, unknown> | null;
}

export interface DispatchStatusPmResolver {
  worker_id: string | null;
  thread_id: string;
  status: PmResolverLifecycleState["status"];
  started_at: string;
  last_seen_at: string;
  agent_type: string | null;
  model_id: string | null;
  mode: string | null;
  auto_approve: boolean | null;
  issue_status: string;
  issue_source: string;
  issue_message: string | null;
  issue_error: string | null;
  reply: string | null;
  error: string | null;
}

export interface DispatchStatusReport extends Record<string, unknown> {
  plan: string;
  dispatch_threads: string;
  generated_at: string;
  stale_threshold_minutes: number;
  workers: DispatchStatusWorker[];
  pm_resolvers: DispatchStatusPmResolver[];
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
  const scanRunId = await loadCurrentScanRunId(planPath);
  const activeProcessCommands = listActiveProcessCommands();
  const registry = await loadProgressRegistryForPlan(planPath);
  const lifecycleStatuses = rows.map((row) => getEffectiveLifecycleStatus(lifecycleState.workers[row.worker_id]));
  const progress = await Promise.all(rows.map((row, index) =>
    loadWorkerProgress(row, scanRunId, registry, planPath, lifecycleStatuses[index])
  ));
  const workers = rows.map((row, index) => buildWorkerStatus(
    row,
    lifecycleState,
    staleThresholdMinutes,
    generatedAt,
    normalizeProgressStatus(
      progress[index] ?? null,
      isWorkerToolProgressActive(row, progress[index] ?? null, scanRunId, activeProcessCommands)
    )
  ));
  const pmResolvers = buildDispatchStatusPmResolvers(lifecycleState);

  return {
    plan: planPath,
    dispatch_threads: resolveDispatchThreadsPath(planPath),
    generated_at: generatedAt,
    stale_threshold_minutes: staleThresholdMinutes,
    workers,
    pm_resolvers: pmResolvers,
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
  generatedAt: string,
  progress: DispatchWorkerProgress | null
): DispatchStatusWorker {
  const workerState = lifecycleState.workers[row.worker_id];
  const lifecycleStatus = getEffectiveLifecycleStatus(workerState);
  const progressOverride = getProgressStatusOverride(progress);
  const displayLifecycleStatus = progressOverride?.lifecycleStatus ?? lifecycleStatus;
  const displayStatus = progressOverride?.status ?? getLifecycleStatusSymbol(displayLifecycleStatus) ?? row.status;
  const staleDurationMs = getStaleDurationMs(displayStatus, workerState?.last_seen_at, staleThresholdMinutes, generatedAt);
  const hasCurrentAssignment = displayLifecycleStatus !== "pending";
  const owner = resolveActiveOwner(row.worker_id, workerState, displayLifecycleStatus, lifecycleState);

  return {
    ...row,
    status: displayStatus,
    lifecycle_status: displayLifecycleStatus,
    thread_id: hasCurrentAssignment ? workerState?.thread_id ?? null : null,
    last_seen_at: hasCurrentAssignment ? workerState?.last_seen_at ?? null : null,
    retry_count: workerState?.retry_count ?? 0,
    failure_reason: progressOverride?.failureReason ?? extractFailureReason(workerState, displayLifecycleStatus),
    stale: staleDurationMs !== null,
    stale_label: staleDurationMs === null ? null : "⚠️ STALE",
    stale_duration_minutes: staleDurationMs === null ? null : Math.floor(staleDurationMs / 60_000),
    stale_duration_human: staleDurationMs === null ? null : formatDuration(staleDurationMs),
    progress,
    active_owner_kind: owner.kind,
    active_owner_thread_id: owner.thread_id
  };
}

function resolveActiveOwner(
  workerId: string,
  workerState: DispatchWorkerState | undefined,
  displayLifecycleStatus: string | null,
  lifecycleState: DispatchThreadStateV2
): { kind: DispatchActiveOwnerKind | null; thread_id: string | null } {
  if (displayLifecycleStatus === "completed" || displayLifecycleStatus === "skipped") {
    return { kind: null, thread_id: null };
  }

  // PM resolver wins if there is a running entry targeting a non-terminal
  // worker. Terminal rows ignore stale PM metadata so they do not look active.
  const runningPm = (lifecycleState.pm_resolvers ?? []).find(
    (entry) => entry.status === "running" && entry.issue?.worker_id === workerId
  );
  if (runningPm?.thread_id) {
    return { kind: "pm_resolver", thread_id: runningPm.thread_id };
  }

  if (displayLifecycleStatus === "awaiting_validation") {
    const validatorThreadId = workerState?.validation?.validator_thread_id?.trim() || null;
    if (validatorThreadId) {
      return { kind: "validator", thread_id: validatorThreadId };
    }
    return { kind: "validator", thread_id: null };
  }

  if (
    displayLifecycleStatus === "running"
    || displayLifecycleStatus === "fix_requested"
  ) {
    const workerThreadId = workerState?.thread_id?.trim() || null;
    return { kind: "worker", thread_id: workerThreadId };
  }

  return { kind: null, thread_id: null };
}

function getLifecycleStatusSymbol(lifecycleStatus: string | null): string | null {
  switch (lifecycleStatus) {
    case "pending":
      return "⬜";
    case "running":
      return "🔄";
    case "completed":
      return "✅";
    case "failed":
      return "❌";
    case "blocked":
      return "⛔ BLOCKED";
    case "abandoned":
      return "⚠️ ABANDONED";
    case "skipped":
      return "⛔ SKIPPED";
    case "awaiting_validation":
      return "🔍";
    default:
      return null;
  }
}

function getEffectiveLifecycleStatus(workerState: DispatchThreadStateV2["workers"][string] | undefined): string | null {
  if (!workerState) {
    return null;
  }

  const workerHubResult = getWorkerOwnedHubResult(workerState);

  if (workerState.status !== "blocked" && workerHubResult && hubResultContainsBlockSignal(workerHubResult)) {
    return "blocked";
  }

  if (
    workerState.status !== "failed"
    && workerState.status !== "blocked"
    && workerHubResult
    && hubResultContainsFailureSignal(workerHubResult)
  ) {
    return "failed";
  }

  return workerState.status;
}

function summarizeWorkers(workers: DispatchStatusWorker[]): DispatchStatusReport["summary"] {
  return workers.reduce<DispatchStatusReport["summary"]>(
    (summary, worker) => {
      summary.total += 1;

      switch (categorizeStatus(getSummaryStatus(worker))) {
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

function getSummaryStatus(worker: DispatchStatusWorker): string {
  if (worker.progress?.status === "running" || worker.progress?.status === "failed") {
    return worker.progress.status;
  }

  return worker.lifecycle_status ?? worker.status;
}

function getProgressStatusOverride(progress: DispatchWorkerProgress | null): {
  status: string;
  lifecycleStatus: string;
  failureReason: string | null;
} | null {
  if (!progress) {
    return null;
  }

  if (progress.status === "running") {
    return {
      status: "🔄",
      lifecycleStatus: "running",
      failureReason: null
    };
  }

  if (progress.status === "failed") {
    return {
      status: "❌",
      lifecycleStatus: "failed",
      failureReason: formatProgressFailureReason(progress)
    };
  }

  return null;
}

function formatProgressFailureReason(progress: DispatchWorkerProgress): string {
  const details = [
    isInactiveProgressProcess(progress) ? "process not running" : null,
    progress.remaining && progress.remaining > 0 ? `${progress.remaining} remaining` : null,
    progress.failed && progress.failed > 0 ? `${progress.failed} failed` : null
  ].filter((value): value is string => value !== null);

  return details.length > 0
    ? `tool progress failed: ${details.join(", ")}`
    : "tool progress failed";
}

function extractFailureReason(
  workerState: DispatchThreadStateV2["workers"][string] | undefined,
  lifecycleStatus: string | null
): string | null {
  if (!workerState || (lifecycleStatus !== "failed" && lifecycleStatus !== "blocked")) {
    return null;
  }

  const hubResult = getWorkerOwnedHubResult(workerState);
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

function getWorkerOwnedHubResult(workerState: DispatchWorkerState | undefined): HubResult | null {
  if (!workerState?.hub_result || isPmResolverHubResult(workerState.hub_result)) {
    return null;
  }

  return workerState.hub_result;
}

function buildDispatchStatusPmResolvers(lifecycleState: DispatchThreadStateV2): DispatchStatusPmResolver[] {
  const explicitEntries = [...(lifecycleState.pm_resolvers ?? [])];
  const explicitWorkerIds = new Set(explicitEntries
    .map((entry) => entry.issue.worker_id)
    .filter((workerId): workerId is string => Boolean(workerId)));
  const recoveredEntries = Object.entries(lifecycleState.workers)
    .filter(([workerId, worker]) => {
      return !explicitWorkerIds.has(workerId) && isPmResolverHubResult(worker.hub_result);
    })
    .map(([workerId, worker]) => buildRecoveredPmResolverEntry(workerId, worker));

  return [...explicitEntries, ...recoveredEntries]
    .sort((left, right) => Date.parse(left.started_at) - Date.parse(right.started_at))
    .map((entry) => ({
      worker_id: entry.issue.worker_id,
      thread_id: entry.thread_id,
      status: entry.status,
      started_at: entry.started_at,
      last_seen_at: entry.last_seen_at,
      agent_type: entry.agent_type,
      model_id: entry.model_id,
      mode: entry.mode,
      auto_approve: entry.auto_approve,
      issue_status: entry.issue.status,
      issue_source: entry.issue.source,
      issue_message: entry.issue.message,
      issue_error: entry.issue.error,
      reply: extractPmResolverReply(entry),
      error: entry.error
    }));
}

function buildRecoveredPmResolverEntry(
  workerId: string,
  worker: DispatchWorkerState
): PmResolverLifecycleState {
  const hubResult = worker.hub_result;
  if (!hubResult) {
    throw new Error(`Cannot recover PM resolver entry without hub result for worker ${workerId}`);
  }

  return {
    thread_id: hubResult.thread_id || worker.thread_id,
    status: worker.status === "failed" || worker.status === "blocked" || worker.status === "abandoned"
      ? "failed"
      : "completed",
    started_at: worker.started_at,
    last_seen_at: hubResult.timestamp ?? worker.last_seen_at,
    agent_type: hubResult.source ?? "pm-resolver",
    model_id: null,
    mode: null,
    auto_approve: null,
    issue: {
      status: "recovered_pm_resolution",
      worker_id: workerId,
      message: "Recovered from worker result recorded before PM resolver history was available.",
      error: null,
      source: "worker_result"
    },
    result: {
      status: hubResult.status,
      run_state: hubResult.run_state ?? null,
      content: hubResult.content,
      summary_text: hubResult.summary_text ?? null,
      details_text: hubResult.details_text ?? null,
      trace_id: hubResult.trace_id,
      timestamp: hubResult.timestamp
    },
    error: null
  };
}

function extractPmResolverReply(entry: PmResolverLifecycleState): string | null {
  return parseDispatchConversationReply(entry.result?.details_text)
    ?? normalizeStatusText(entry.result?.summary_text)
    ?? normalizeStatusText(entry.result?.content)
    ?? normalizeStatusText(entry.error)
    ?? (entry.status === "running" ? "PM resolver is running; waiting for its reply." : null);
}

function parseDispatchConversationReply(detailsText: string | null | undefined): string | null {
  const normalized = normalizeStatusText(detailsText);
  if (!normalized) {
    return null;
  }

  const conversationMatch = normalized.match(/^Your message:\n([\s\S]*?)(?:\n{2,}Agent reply:\n([\s\S]*))?$/);
  if (conversationMatch) {
    return normalizeStatusText(conversationMatch[2]);
  }

  const replyMatch = normalized.match(/(?:^|\n)Agent reply:\n([\s\S]*)$/);
  return normalizeStatusText(replyMatch?.[1]);
}

function normalizeStatusText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/\r\n/g, "\n").trim();
  return normalized.length > 0 ? normalized : null;
}

async function loadWorkerProgressFromRegistry(
  row: DispatchPlanWorkerRow,
  scanRunId: string | null,
  registry: ProgressRegistry | null,
  planPath: string
): Promise<DispatchWorkerProgress | null> {
  const resolved = resolveProgressSource(registry, planPath, row.worker_id);
  if (!resolved) {
    return null;
  }
  return fetchProgressFromSource(resolved, row.worker_id, scanRunId);
}

async function loadWorkerProgress(
  row: DispatchPlanWorkerRow,
  scanRunId: string | null,
  registry: ProgressRegistry | null,
  planPath: string,
  lifecycleStatus: string | null
): Promise<DispatchWorkerProgress | null> {
  // Progress signals (real progress files and the cumulative-DB fallback) are only meaningful
  // for workers the dispatcher has actually dispatched. For undispatched workers (lifecycle
  // null/pending) the data we'd surface is from previous runs — a stale progress file, or
  // cumulative DB rows persisted by earlier cycles — and `normalizeProgressStatus` would then
  // flip those to "failed" because no live process exists. That synthetic failure poisons
  // both the UI and `isManualInterventionBlocker`, pausing the scheduler on a worker it has
  // not yet attempted.
  if (lifecycleStatus === null || lifecycleStatus === "pending") {
    return null;
  }

  const fromRegistry = await loadWorkerProgressFromRegistry(row, scanRunId, registry, planPath);
  if (fromRegistry) {
    return fromRegistry;
  }

  const expandedTask = expandScanRunId(row.task, scanRunId);
  const progressPath = resolveProgressPath(expandedTask);
  if (!progressPath) {
    return computeClawHubProgressFallback(row, expandedTask);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(progressPath, "utf8"));
  } catch {
    return computeClawHubProgressFallback(row, expandedTask);
  }

  if (!isRecord(parsed)) {
    return null;
  }

  return {
    progress_path: progressPath,
    source: "progress_file",
    command: readString(parsed.command) ?? "unknown",
    scan_run_id: readString(parsed.scan_run_id),
    status: readString(parsed.status) ?? "unknown",
    total: readNumber(parsed.total),
    processed: readNumber(parsed.processed),
    success: readNumber(parsed.success),
    failed: readNumber(parsed.failed),
    skipped: readNumber(parsed.skipped),
    skipped_existing: readNumber(parsed.skipped_existing),
    remaining: readNumber(parsed.remaining),
    started_at: readString(parsed.started_at),
    updated_at: readString(parsed.updated_at),
    completed_at: readString(parsed.completed_at),
    pid: readNumber(parsed.pid),
    rate_limit_waits: readNumber(parsed.rate_limit_waits),
    last_skill: readLastSkill(parsed.last_skill)
  };
}

function resolveProgressPath(task: string | null): string | null {
  if (!task) {
    return null;
  }

  const explicit = extractOptionValue(task, "progress");
  if (explicit) {
    return path.resolve(explicit);
  }

  const manifestPath = extractOptionValue(task, "manifest");
  if (!manifestPath) {
    return null;
  }

  if (/\bdetail-fetch\b/.test(task)) {
    return path.join(path.dirname(path.resolve(manifestPath)), "detail-fetch.progress.json");
  }

  if (/\bssr-enrich\b/.test(task)) {
    return path.join(path.dirname(path.resolve(manifestPath)), "ssr-enrich.progress.json");
  }

  return null;
}

async function computeClawHubProgressFallback(
  row: DispatchPlanWorkerRow,
  task: string | null
): Promise<DispatchWorkerProgress | null> {
  if (!task || !/\bclawhub-fetch\b/.test(task) || !/\bdetail-fetch\b/.test(task)) {
    return null;
  }

  const dbPath = extractOptionValue(task, "db");
  const taskManifestPath = extractOptionValue(task, "manifest");
  if (!dbPath || !taskManifestPath) {
    return null;
  }

  const manifestPath = await resolveManagedDetailManifestPath(row, taskManifestPath);
  const manifest = await readJsonFile(manifestPath);
  if (!isRecord(manifest) || !Array.isArray(manifest.skills)) {
    return null;
  }

  const versionKeys = loadClawHubVersionKeys(dbPath);
  if (!versionKeys) {
    return null;
  }

  const total = manifest.skills.length;
  const processed = manifest.skills.reduce((count, skill) => {
    if (!isRecord(skill)) {
      return count;
    }

    const owner = readString(skill.owner);
    const slug = readString(skill.slug);
    const version = readString(skill.latest_version);
    if (!owner || !slug || !version) {
      return count;
    }

    return versionKeys.has(`${owner}/${slug}@${version}`) ? count + 1 : count;
  }, 0);
  const remaining = Math.max(0, total - processed);

  return {
    progress_path: manifestPath,
    source: "fallback",
    command: "detail-fetch",
    scan_run_id: readString(manifest.scan_run_id),
    status: remaining > 0 ? "running" : "completed",
    total,
    processed,
    success: processed,
    failed: 0,
    skipped: 0,
    skipped_existing: 0,
    remaining,
    started_at: null,
    updated_at: new Date().toISOString(),
    completed_at: null,
    pid: null,
    rate_limit_waits: null,
    last_skill: null
  };
}

function normalizeProgressStatus(
  progress: DispatchWorkerProgress | null,
  activeProcessRunning: boolean
): DispatchWorkerProgress | null {
  if (!progress) {
    return null;
  }

  if (progress.status === "running" && !activeProcessRunning && (progress.source === "fallback" || progress.pid !== null)) {
    return {
      ...progress,
      status: "failed",
      extra: {
        ...(isRecord(progress.extra) ? progress.extra : {}),
        inactive_process: true
      }
    };
  }

  return progress;
}

function listActiveProcessCommands(): string[] {
  try {
    const output = execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isWorkerToolProgressActive(
  row: DispatchPlanWorkerRow,
  progress: DispatchWorkerProgress | null,
  scanRunId: string | null,
  activeProcessCommands: string[]
): boolean {
  if (!progress || activeProcessCommands.length === 0) {
    return false;
  }

  const effectiveScanRunId = progress.scan_run_id ?? scanRunId;
  if (!effectiveScanRunId || !progress.command) {
    return false;
  }

  const expandedTask = expandScanRunId(row.task, effectiveScanRunId) ?? "";
  const executable = extractTaskExecutable(expandedTask);

  return activeProcessCommands.some((commandLine) => {
    if (progress.pid !== null && !commandLine.trimStart().startsWith(`${progress.pid} `)) {
      return false;
    }

    if (!commandLine.includes(effectiveScanRunId) || !commandLine.includes(progress.command)) {
      return false;
    }

    if (!executable) {
      return true;
    }

    return commandLine.includes(executable) || commandLine.includes(path.basename(executable));
  });
}

function isInactiveProgressProcess(progress: DispatchWorkerProgress): boolean {
  return isRecord(progress.extra) && progress.extra.inactive_process === true;
}

function extractTaskExecutable(task: string): string | null {
  const codeSpanMatch = task.match(/`([^`]+)`/);
  const command = (codeSpanMatch?.[1] ?? task).trim();
  const firstToken = command.match(/^(?:"([^"]+)"|'([^']+)'|`([^`]+)`|(\S+))/);
  return firstToken?.[1] ?? firstToken?.[2] ?? firstToken?.[3] ?? firstToken?.[4] ?? null;
}

async function resolveManagedDetailManifestPath(
  row: DispatchPlanWorkerRow,
  manifestPath: string
): Promise<string> {
  if (row.worker_id !== "W-DETAIL") {
    return path.resolve(manifestPath);
  }

  const managedManifestPath = path.join(path.dirname(path.resolve(manifestPath)), "W-DETAIL.remaining-managed.json");
  return await fileExists(managedManifestPath) ? managedManifestPath : path.resolve(manifestPath);
}

function loadClawHubVersionKeys(dbPath: string): Set<string> | null {
  let rows: unknown;
  try {
    const output = execFileSync("sqlite3", [
      "-json",
      dbPath,
      "SELECT owner, slug, version_string FROM clawhub_skill_version"
    ], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    }).trim();
    rows = output ? JSON.parse(output) : [];
  } catch {
    return null;
  }

  if (!Array.isArray(rows)) {
    return null;
  }

  return new Set(rows.flatMap((row) => {
    if (!isRecord(row)) {
      return [];
    }

    const owner = readString(row.owner);
    const slug = readString(row.slug);
    const version = readString(row.version_string);
    return owner && slug && version ? [`${owner}/${slug}@${version}`] : [];
  }));
}

async function loadCurrentScanRunId(planPath: string): Promise<string | null> {
  const state = await readJsonFile(path.join(path.dirname(planPath), "scheduler_state.json"));
  return isRecord(state) ? readString(state.current_scan_run_id) : null;
}

function expandScanRunId(task: string | null, scanRunId: string | null): string | null {
  if (!task || !scanRunId) {
    return task;
  }

  return task.replace(/\$\{SCAN_RUN_ID\}|\$SCAN_RUN_ID/g, scanRunId);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function extractOptionValue(command: string, optionName: string): string | null {
  const pattern = new RegExp(`(?:^|\\s)--${optionName}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s]+))`);
  const match = command.match(pattern);
  const value = match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  return value ? value.replace(/^`|`$/g, "") : null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  if (status === "⛔ BLOCKED" || status === "blocked") {
    return "failed";
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
