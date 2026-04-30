import * as fs from "node:fs";
import path from "node:path";

import type {
  SchedulerConfig,
  SchedulerRunSummary,
  TerminalOutcome,
  DispatchThreadStateV2
} from "../../types";
import { SchedulerStateStore } from "./scheduler-state-store";
import { acquirePlanLock, releasePlanLock } from "./plan-lock";
import { archiveRun, type ArchiveResult } from "./archiver";
import { hubResultContainsFailureSignal } from "../agent-dispatcher/lifecycle-store";

const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";

// Terminal statuses for non-human workers
const TERMINAL_STATUSES = new Set(["completed", "failed", "abandoned", "skipped"]);

// Statuses that represent human-safe completion (auto-continue)
const AUTO_CONTINUE_OUTCOMES = new Set<TerminalOutcome>(["completed", "completed_with_skips"]);

// Statuses that require human intervention (pause scheduler)
const PAUSE_OUTCOMES = new Set<TerminalOutcome>(["failed", "manual_intervention_required"]);

// Human/PM model codes
const HUMAN_MODELS = new Set(["HUMAN", "PM"]);

export interface CycleStartResult {
  ok: boolean;
  run_id?: string;
  error?: string;
}

export interface CycleCompletionResult {
  terminal_outcome: TerminalOutcome;
  should_continue: boolean;
  archive?: ArchiveResult;
  error?: string;
}

export function canStartCycle(
  stateStore: SchedulerStateStore,
  schedulerThreadId: string
): { ok: boolean; reason?: string } {
  const state = stateStore.load();

  if (state.status === "active_run") {
    return { ok: false, reason: "A cycle is already active" };
  }
  if (state.status === "manual_intervention_required") {
    return { ok: false, reason: "Manual intervention required before next cycle" };
  }
  if (state.status === "completed_max_cycles") {
    return { ok: false, reason: "Max cycles reached" };
  }

  if (state.plan_lock_owner && state.plan_lock_owner !== schedulerThreadId) {
    return { ok: false, reason: `Plan locked by ${state.plan_lock_owner}` };
  }

  return { ok: true };
}

export function startCycle(
  stateStore: SchedulerStateStore,
  config: SchedulerConfig,
  schedulerThreadId: string,
  runId: string,
  plannedStartTime: string | null = null
): CycleStartResult {
  // Acquire plan lock
  const lockResult = acquirePlanLock(stateStore, schedulerThreadId, runId);
  if (!lockResult.acquired) {
    return {
      ok: false,
      error: `Plan lock held by ${lockResult.held_by}`
    };
  }

  // Reset dispatch plan statuses
  resetDispatchPlan(config.dispatch_plan_path);

  // Reset lifecycle sidecar
  resetLifecycleSidecar(config.dispatch_plan_path);

  // Update scheduler run state
  const state = stateStore.load();
  state.status = "active_run";
  state.current_run_id = runId;
  state.current_run_report_dir = path.join(config.report_base_dir, "runs", runId);
  state.current_scan_run_id = deriveScanRunId(config, plannedStartTime);
  state.current_dispatcher_thread_id = null;
  state.current_run_planned_start_time = plannedStartTime;
  state.current_run_actual_start_time = new Date().toISOString();
  state.next_run_at = null;
  stateStore.save(state);

  return { ok: true, run_id: runId };
}

export function recordDispatcherLaunch(
  stateStore: SchedulerStateStore,
  dispatcherThreadId: string
): void {
  const state = stateStore.load();
  state.current_dispatcher_thread_id = dispatcherThreadId;
  stateStore.save(state);
}

export function detectCycleCompletion(
  config: SchedulerConfig
): { complete: boolean; outcome?: TerminalOutcome } {
  const threadsPath = path.join(path.dirname(config.dispatch_plan_path), DISPATCH_THREADS_FILENAME);

  let threadsContent: string;
  try {
    threadsContent = fs.readFileSync(threadsPath, "utf8");
  } catch {
    return { complete: false };
  }

  let lifecycleState: DispatchThreadStateV2;
  try {
    lifecycleState = JSON.parse(threadsContent) as DispatchThreadStateV2;
  } catch {
    return { complete: false };
  }

  if (!lifecycleState.workers || Object.keys(lifecycleState.workers).length === 0) {
    return { complete: false };
  }

  // Also parse the plan to check for human/PM rows without lifecycle entries
  const planPath = config.dispatch_plan_path;
  const planWorkers = parsePlanWorkerModels(planPath);

  let hasFailure = false;
  let hasSkips = false;
  let hasManualIntervention = false;

  if (planWorkers.size === 0) {
    for (const worker of Object.values(lifecycleState.workers)) {
      const workerStatus = getEffectiveWorkerStatus(worker);
      if (!TERMINAL_STATUSES.has(workerStatus)) {
        return { complete: false };
      }

      if (workerStatus === "failed" || workerStatus === "abandoned") {
        hasFailure = true;
      }
      if (workerStatus === "skipped") {
        hasSkips = true;
      }
    }
  } else {
    // Every plan row must either have reached a terminal lifecycle state or, for
    // human rows, be surfaced as manual intervention. Extra lifecycle rows such
    // as the wrapper dispatcher cannot prove the actual plan completed.
    for (const [workerId, model] of planWorkers) {
      const worker = lifecycleState.workers[workerId];
      const isHumanWorker = HUMAN_MODELS.has(model.toUpperCase());
      const workerStatus = getEffectiveWorkerStatus(worker);

      if (!worker || !TERMINAL_STATUSES.has(workerStatus)) {
        if (isHumanWorker) {
          hasManualIntervention = true;
          continue;
        }
        return { complete: false };
      }

      if (isHumanWorker) {
        continue;
      }

      if (workerStatus === "failed" || workerStatus === "abandoned") {
        hasFailure = true;
      }
      if (workerStatus === "skipped") {
        hasSkips = true;
      }
    }

    for (const [workerId, worker] of Object.entries(lifecycleState.workers)) {
      if (planWorkers.has(workerId)) {
        continue;
      }

      const workerStatus = getEffectiveWorkerStatus(worker);
      if (!TERMINAL_STATUSES.has(workerStatus)) {
        return { complete: false };
      }
      if (workerStatus === "failed" || workerStatus === "abandoned") {
        hasFailure = true;
      }
      if (workerStatus === "skipped") {
        hasSkips = true;
      }
    }
  }

  if (hasManualIntervention) {
    return { complete: true, outcome: "manual_intervention_required" };
  }
  if (hasFailure) {
    return { complete: true, outcome: "failed" };
  }
  if (hasSkips) {
    return { complete: true, outcome: "completed_with_skips" };
  }
  return { complete: true, outcome: "completed" };
}

function getEffectiveWorkerStatus(worker: DispatchThreadStateV2["workers"][string] | undefined): string {
  if (!worker) {
    return "pending";
  }

  if (worker.status !== "failed" && worker.hub_result && hubResultContainsFailureSignal(worker.hub_result)) {
    return "failed";
  }

  return worker.status;
}

export function completeCycle(
  stateStore: SchedulerStateStore,
  config: SchedulerConfig,
  schedulerThreadId: string
): CycleCompletionResult {
  const state = stateStore.load();

  const runId = state.current_run_id;
  const dispatcherThreadId = state.current_dispatcher_thread_id;
  const plannedStartTime = state.current_run_planned_start_time;
  const actualStartTime = state.current_run_actual_start_time ?? state.last_run_completed_at ?? new Date().toISOString();

  if (!runId) {
    return {
      terminal_outcome: "cancelled",
      should_continue: false,
      error: "No active run to complete"
    };
  }

  const detection = detectCycleCompletion(config);
  if (!detection.complete || !detection.outcome) {
    return {
      terminal_outcome: "cancelled",
      should_continue: false,
      error: "Cycle not yet complete"
    };
  }

  const now = new Date().toISOString();
  const outcome = detection.outcome;

  // Archive the run
  let archive: ArchiveResult;
  try {
    archive = archiveRun({
      runId,
      config,
      actualStartTime,
      completedTime: now,
      dispatcherThreadId,
      terminalOutcome: outcome,
      completedCycles: state.completed_cycles + 1,
      plannedStartTime
    });
  } catch (error) {
    // Archival failure — do NOT reset plan
    state.status = "manual_intervention_required";
    stateStore.save(state);
    return {
      terminal_outcome: outcome,
      should_continue: false,
      error: `Archival failed: ${asError(error).message}`
    };
  }

  // Reset safety check
  if (!archive.planSnapshotMatches) {
    state.status = "manual_intervention_required";
    stateStore.save(state);
    return {
      terminal_outcome: outcome,
      should_continue: false,
      archive,
      error: "Plan changed during archival — reset blocked"
    };
  }

  // Update state
  state.completed_cycles += 1;
  state.last_run_completed_at = now;
  state.last_run_outcome = outcome;
  state.last_report_path = archive.reportPath;

  state.run_history.push(readArchivedRunSummary(archive.jsonReportPath) ?? {
    run_id: runId,
    scheduler_mode: config.scheduler_mode,
    planned_start_time: plannedStartTime,
    actual_start_time: actualStartTime,
    completed_time: now,
    duration_seconds: null,
    dispatcher_thread_id: dispatcherThreadId,
    terminal_outcome: outcome,
    workers: []
  });

  state.current_run_id = null;
  state.current_run_report_dir = null;
  state.current_scan_run_id = null;
  state.current_dispatcher_thread_id = null;
  state.current_run_planned_start_time = null;
  state.current_run_actual_start_time = null;
  state.next_run_at = null;

  // Determine next action
  const shouldContinue = AUTO_CONTINUE_OUTCOMES.has(outcome);

  if (PAUSE_OUTCOMES.has(outcome)) {
    state.status = "manual_intervention_required";
  } else if (config.max_cycles && state.completed_cycles >= config.max_cycles) {
    state.status = "completed_max_cycles";
  } else if (shouldContinue) {
    state.status = "waiting";
  } else {
    state.status = "idle";
  }

  // Release plan lock
  releasePlanLock(stateStore, schedulerThreadId);
  state.plan_lock_owner = null;

  stateStore.save(state);

  return {
    terminal_outcome: outcome,
    should_continue: shouldContinue && state.status === "waiting",
    archive
  };
}

export function cancelCycle(
  stateStore: SchedulerStateStore,
  schedulerThreadId: string
): void {
  const state = stateStore.load();
  const now = new Date().toISOString();

  state.status = "idle";
  state.current_run_id = null;
  state.current_run_report_dir = null;
  state.current_scan_run_id = null;
  state.current_dispatcher_thread_id = null;
  state.current_run_planned_start_time = null;
  state.current_run_actual_start_time = null;
  state.next_run_at = null;
  state.last_run_completed_at = now;
  state.last_run_outcome = "cancelled";

  releasePlanLock(stateStore, schedulerThreadId);
  state.plan_lock_owner = null;
  stateStore.save(state);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function deriveScanRunId(config: SchedulerConfig, plannedStartTime: string | null): string | null {
  if (config.scan_run_id_strategy !== "daily-date") {
    return null;
  }

  const prefix = config.scan_run_id_prefix ?? "daily";
  return `${prefix}-${formatDateInTimezone(plannedStartTime ?? new Date().toISOString(), config.timezone)}`;
}

function formatDateInTimezone(isoTimestamp: string, timezone: string): string {
  const date = new Date(isoTimestamp);
  const timeZone = timezone === "system" ? undefined : timezone;

  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch {
    // Fall back to UTC below when an invalid timezone is configured.
  }

  return date.toISOString().slice(0, 10);
}

function resetDispatchPlan(planPath: string): void {
  let content: string;
  try {
    content = fs.readFileSync(planPath, "utf8");
  } catch {
    return;
  }

  // Reset all status cells in the dispatch plan table
  const lines = content.split(/\r?\n/);
  let mutated = false;

  for (let i = 0; i < lines.length - 1; i++) {
    const headerCells = parseTableRow(lines[i]!);
    if (!headerCells) continue;

    const statusCol = headerCells.indexOf("Status");
    if (statusCol === -1) continue;

    const separatorCells = parseTableRow(lines[i + 1]!);
    if (!separatorCells || !isSeparatorRow(separatorCells)) continue;

    for (let j = i + 2; j < lines.length; j++) {
      const rowCells = parseTableRow(lines[j]!);
      if (!rowCells || rowCells.length !== headerCells.length) break;

      const currentStatus = rowCells[statusCol]!.trim();
      if (currentStatus !== "⬜") {
        rowCells[statusCol] = "⬜";
        lines[j] = `| ${rowCells.join(" | ")} |`;
        mutated = true;
      }
    }
    break;
  }

  if (mutated) {
    fs.writeFileSync(planPath, lines.join("\n"), "utf8");
  }
}

function resetLifecycleSidecar(planPath: string): void {
  const threadsPath = path.join(path.dirname(planPath), DISPATCH_THREADS_FILENAME);
  const emptyState = {
    version: 2,
    dispatcher: { thread_id: null, started_at: null, status: "pending" },
    workers: {},
    last_reconciled_at: null
  };

  fs.mkdirSync(path.dirname(threadsPath), { recursive: true });
  fs.writeFileSync(threadsPath, `${JSON.stringify(emptyState, null, 2)}\n`, "utf8");
}

function parsePlanWorkerModels(planPath: string): Map<string, string> {
  const models = new Map<string, string>();

  let content: string;
  try {
    content = fs.readFileSync(planPath, "utf8");
  } catch {
    return models;
  }

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const headerCells = parseTableRow(lines[i]!);
    if (!headerCells) continue;

    const normalizedHeaders = headerCells.map(normalizeHeaderCell);
    const workerCol = normalizedHeaders.indexOf("worker");
    const modelCol = normalizedHeaders.indexOf("model");
    if (workerCol === -1 || modelCol === -1) continue;

    const separatorCells = parseTableRow(lines[i + 1]!);
    if (!separatorCells || !isSeparatorRow(separatorCells)) continue;

    for (let j = i + 2; j < lines.length; j++) {
      const rowCells = parseTableRow(lines[j]!);
      if (!rowCells || rowCells.length !== headerCells.length) break;

      const workerId = rowCells[workerCol]!.trim();
      const model = rowCells[modelCol]!.trim();
      if (workerId && model) {
        models.set(workerId, model);
      }
    }
    break;
  }

  return models;
}

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;

  const withoutLeading = trimmed.slice(1);
  const normalized = withoutLeading.endsWith("|")
    ? withoutLeading.slice(0, -1)
    : withoutLeading;

  return normalized.split("|").map((cell) => cell.trim());
}

function normalizeHeaderCell(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function readArchivedRunSummary(jsonReportPath: string): SchedulerRunSummary | null {
  try {
    return JSON.parse(fs.readFileSync(jsonReportPath, "utf8")) as SchedulerRunSummary;
  } catch {
    return null;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
