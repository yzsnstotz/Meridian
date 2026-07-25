import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";

import type {
  AgentType,
  DispatchWorkerState,
  HubResult,
  KillPolicy,
  LifecycleStatus,
  SchedulerConfig,
  SchedulerMode,
  TerminalOutcome
} from "../../types";
import { buildDispatchStatusReport, type DispatchStatusWorker } from "../../tool-gateway/tools/dispatch-status";
import type { Logger } from "../base-role";
import {
  isWorkerToolProcessRunning,
  listActiveProcessCommands,
  loadPlanRowsByWorker
} from "../agent-dispatcher/active-tool-process";
import { continueDispatchWorker, type ContinueDispatchPlanRow, type ContinueDispatchWorkerResult } from "../agent-dispatcher/continue-worker";
import { LifecycleStore, hubResultContainsBlockSignal, hubResultContainsFailureSignal, isNonCompletionContent } from "../agent-dispatcher/lifecycle-store";
import { isHubTransportEvidence, isMissingThreadEvidence } from "../agent-dispatcher/missing-thread";
import { resolveServiceContinueWorkerFromWorkerRows } from "../agent-dispatcher/service-continuation";
import { SchedulerStateStore } from "./scheduler-state-store";
import { nextCronFire } from "./cron-parser";
import {
  canStartCycle,
  startCycle,
  recordDispatcherLaunch,
  detectCycleCompletion,
  completeCycle,
  cancelCycle
} from "./cycle-manager";

const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";
const DISPATCHER_WORKER_ID = "DISPATCHER";

export interface SchedulerEngineCallbacks {
  launchDispatcher(config: SchedulerConfig, runId: string): Promise<string>;
  killDispatcher(threadId: string): Promise<void>;
  notifyChannels(config: SchedulerConfig, message: string): Promise<void>;
  continueWorker?(config: SchedulerConfig, workerId: string): Promise<ContinueDispatchWorkerResult>;
}

export interface SchedulerEngineOptions {
  schedulerThreadId: string;
  config: SchedulerConfig;
  stateStore: SchedulerStateStore;
  callbacks: SchedulerEngineCallbacks;
  log: Logger;
  /** Test seam for the cleanup transport-stall cooldown gate. */
  now?: () => number;
}

/**
 * See watchdog.ts CLEANUP_KILL_TRANSPORT_COOLDOWN_MS — same rationale: when
 * the Hub returns an IPC transport error on kill, the kill outcome is
 * unknown; sleeping this long between retries keeps a single Hub-overload
 * window from becoming a per-tick kill loop that floods the log.
 */
const CLEANUP_KILL_TRANSPORT_COOLDOWN_MS = 60_000;

export class SchedulerEngine {
  private readonly schedulerThreadId: string;
  private config: SchedulerConfig;
  private readonly stateStore: SchedulerStateStore;
  private readonly callbacks: SchedulerEngineCallbacks;
  private readonly log: Logger;

  private scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly cleanedTerminalThreadIds = new Set<string>();
  // Per-thread cooldown for terminal-kill calls that returned a Hub IPC
  // transport error. Mirrors the watchdog's gate — same rationale.
  private readonly cleanupKillTransportCooldownUntilMs = new Map<string, number>();
  private readonly now: () => number;

  private static readonly POLL_INTERVAL_MS = 30_000;

  constructor(options: SchedulerEngineOptions) {
    this.schedulerThreadId = options.schedulerThreadId;
    this.config = options.config;
    this.stateStore = options.stateStore;
    this.callbacks = options.callbacks;
    this.log = options.log;
    this.now = options.now ?? Date.now;
  }

  getConfig(): SchedulerConfig {
    return this.config;
  }

  updateConfig(config: SchedulerConfig): void {
    this.config = config;
    if (this.releaseCompletedMaxCyclesIfConfigAllows()) {
      this.scheduleNextCycle();
    }
  }

  start(): void {
    this.stopped = false;

    this.releaseCompletedMaxCyclesIfConfigAllows();
    const state = this.stateStore.load();

    if (state.status === "active_run") {
      // Resume monitoring an existing run
      this.startCompletionPolling();
      return;
    }

    if (state.status === "manual_intervention_required" || state.status === "completed_max_cycles" || state.status === "paused") {
      return;
    }

    this.scheduleNextCycle();
  }

  private releaseCompletedMaxCyclesIfConfigAllows(): boolean {
    const state = this.stateStore.load();
    if (state.status !== "completed_max_cycles") {
      return false;
    }
    if (this.config.max_cycles && state.completed_cycles >= this.config.max_cycles) {
      return false;
    }

    state.status = "idle";
    state.next_run_at = null;
    this.stateStore.save(state);
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();

    const state = this.stateStore.load();
    if (state.status === "waiting") {
      state.status = "idle";
      state.next_run_at = null;
      this.stateStore.save(state);
    }
  }

  pause(): void {
    this.clearTimers();

    const state = this.stateStore.load();
    if (state.status !== "active_run") {
      state.status = "paused";
      state.next_run_at = null;
      this.stateStore.save(state);
    } else {
      // Keep status as active_run but stop polling
      // The child dispatcher will be paused separately by the role
    }
  }

  resume(): void {
    this.stopped = false;

    const state = this.stateStore.load();
    if (state.status === "paused") {
      state.status = "idle";
      this.stateStore.save(state);
      this.scheduleNextCycle();
    } else if (state.status === "manual_intervention_required" && state.current_run_id) {
      state.status = "active_run";
      state.next_run_at = null;
      this.stateStore.save(state);
      this.startCompletionPolling();
    } else if (state.status === "active_run") {
      // Resume polling for completion
      this.startCompletionPolling();
    }
  }

  async runNow(reportBaseDirOverride?: string): Promise<{ ok: boolean; run_id?: string; error?: string }> {
    const config = reportBaseDirOverride
      ? { ...this.config, report_base_dir: reportBaseDirOverride }
      : this.config;

    return this.executeCycle(config, null);
  }

  async cancelActiveRun(): Promise<void> {
    const state = this.stateStore.load();

    if (state.current_dispatcher_thread_id) {
      try {
        await this.callbacks.killDispatcher(state.current_dispatcher_thread_id);
      } catch (error) {
        this.log.warn("Failed to kill dispatcher during cancel", {
          error: asError(error).message
        });
      }
    }

    cancelCycle(this.stateStore, this.schedulerThreadId);
    this.clearTimers();

    await this.callbacks.notifyChannels(this.config, buildCancelNotification(this.schedulerThreadId)).catch(() => {});
  }

  async continueWorker(workerId: string): Promise<ContinueDispatchWorkerResult> {
    let report: Awaited<ReturnType<typeof buildDispatchStatusReport>>;
    try {
      report = await buildDispatchStatusReport(this.config.dispatch_plan_path);
    } catch (error) {
      return {
        ok: false,
        workerId,
        error: asError(error).message
      };
    }

    return this.continueSchedulerWorker(workerId, report.workers);
  }

  // ─── Internal scheduling logic ──────────────────────────────────────────────

  private scheduleNextCycle(): void {
    if (this.stopped) return;

    const mode = this.config.scheduler_mode;

    if (mode === "none") {
      return;
    }

    const shouldStartImmediately = this.resolveStartImmediately(mode);
    const state = this.stateStore.load();

    // If this is the first schedule and start_immediately is true
    if (shouldStartImmediately && state.completed_cycles === 0 && state.status === "idle") {
      void this.executeCycle(this.config, null);
      return;
    }

    const delayMs = this.computeNextDelay(mode);
    if (delayMs === null) return;

    const nextRunAt = new Date(Date.now() + delayMs).toISOString();
    const currentState = this.stateStore.load();
    if (
      currentState.status === "manual_intervention_required" ||
      currentState.status === "completed_max_cycles" ||
      currentState.status === "paused" ||
      currentState.status === "active_run"
    ) {
      return;
    }

    currentState.status = "waiting";
    currentState.next_run_at = nextRunAt;
    this.stateStore.save(currentState);

    this.log.info("Scheduler: next cycle scheduled", {
      schedulerThreadId: this.schedulerThreadId,
      mode,
      nextRunAt,
      delayMs
    });

    this.scheduleTimer = setTimeout(() => {
      void this.executeCycle(this.config, nextRunAt);
    }, delayMs);
    this.scheduleTimer.unref?.();
  }

  private resolveStartImmediately(mode: SchedulerMode): boolean {
    if (this.config.start_immediately !== undefined) {
      return this.config.start_immediately;
    }
    // Default: false for cron, true for interval/loop
    return mode !== "cron";
  }

  private computeNextDelay(mode: SchedulerMode): number | null {
    if (mode === "cron") {
      return this.computeCronDelay();
    }

    if (mode === "interval") {
      return (this.config.interval_seconds ?? 60) * 1000;
    }

    if (mode === "loop") {
      return (this.config.delay_between_cycles_seconds ?? 0) * 1000;
    }

    return null;
  }

  private computeCronDelay(): number | null {
    if (!this.config.cron_expression) return null;

    try {
      const nextFire = nextCronFire(
        this.config.cron_expression,
        new Date(),
        this.config.timezone ?? "system"
      );
      return Math.max(0, nextFire.getTime() - Date.now());
    } catch (error) {
      this.log.error("Failed to compute next cron fire", {
        expression: this.config.cron_expression,
        error: asError(error).message
      });
      return null;
    }
  }

  private async executeCycle(
    config: SchedulerConfig,
    plannedStartTime: string | null
  ): Promise<{ ok: boolean; run_id?: string; error?: string }> {
    if (this.stopped) return { ok: false, error: "Scheduler stopped" };

    const check = canStartCycle(this.stateStore, this.schedulerThreadId);
    if (!check.ok) {
      // Overlap — skip and notify
      if (config.scheduler_mode === "cron") {
        await this.callbacks.notifyChannels(config, buildOverlapNotification(this.schedulerThreadId, plannedStartTime));
        this.scheduleNextCycle();
      }
      return { ok: false, error: check.reason };
    }

    const runId = randomUUID();

    const result = startCycle(
      this.stateStore,
      config,
      this.schedulerThreadId,
      runId,
      plannedStartTime
    );

    if (!result.ok) {
      this.scheduleNextCycle();
      return result;
    }

    // Notify start
    await this.callbacks.notifyChannels(config, buildStartNotification(
      this.schedulerThreadId, runId, config.scheduler_mode, plannedStartTime
    )).catch(() => {});

    // Launch child dispatcher
    try {
      const dispatcherThreadId = await this.callbacks.launchDispatcher(config, runId);
      recordDispatcherLaunch(this.stateStore, dispatcherThreadId);
    } catch (error) {
      this.log.error("Failed to launch child dispatcher", {
        runId,
        error: asError(error).message
      });
      cancelCycle(this.stateStore, this.schedulerThreadId);
      this.scheduleNextCycle();
      return { ok: false, error: asError(error).message };
    }

    // Start polling for completion
    this.startCompletionPolling();

    return { ok: true, run_id: runId };
  }

  private startCompletionPolling(): void {
    this.clearPollTimer();

    this.pollTimer = setInterval(() => {
      void this.checkCycleCompletion();
    }, SchedulerEngine.POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  private async checkCycleCompletion(): Promise<void> {
    if (await this.hasRunningToolProgress()) {
      return;
    }

    this.recoverCurrentRunOutputEvidence();
    await this.cleanupTerminalWorkerThreads();

    const detection = detectCycleCompletion(this.config);
    if (!detection.complete) {
      await this.continueIncompleteCycle();
      return;
    }

    this.clearPollTimer();

    const result = completeCycle(this.stateStore, this.config, this.schedulerThreadId);

    // Notify completion
    await this.callbacks.notifyChannels(this.config, buildCompletionNotification(
      this.schedulerThreadId,
      result.terminal_outcome,
      result.archive?.reportPath ?? null
    )).catch(() => {});

    if (result.error) {
      this.log.warn("Cycle completion issue", {
        error: result.error,
        outcome: result.terminal_outcome
      });
    }

    if (result.should_continue) {
      this.scheduleNextCycle();
    }
  }

  private async continueIncompleteCycle(): Promise<void> {
    let report: Awaited<ReturnType<typeof buildDispatchStatusReport>>;
    try {
      report = await buildDispatchStatusReport(this.config.dispatch_plan_path);
    } catch (error) {
      this.log.warn("Scheduler: failed to read dispatch status for continuation", {
        schedulerThreadId: this.schedulerThreadId,
        error: asError(error).message
      });
      return;
    }

    if (report.summary.running > 0 || report.summary.pending === 0 || this.isDispatcherControllerRunning()) {
      return;
    }

    const workerId = this.resolveServiceContinueWorker(report.workers);
    if (!workerId) {
      await this.pauseForManualInterventionIfBlocked(report.workers);
      return;
    }

    const result = await this.continueSchedulerWorker(workerId, report.workers);
    if (!result.ok) {
      this.log.warn("Scheduler: continue worker failed", {
        schedulerThreadId: this.schedulerThreadId,
        error: result.error
      });
      return;
    }

    this.log.info("Scheduler: continued incomplete cycle", {
      schedulerThreadId: this.schedulerThreadId,
      worker: result.workerId
    });
  }

  private async pauseForManualInterventionIfBlocked(workers: DispatchStatusWorker[]): Promise<void> {
    const blocker = workers.find(isManualInterventionBlocker);
    if (!blocker) {
      return;
    }

    const state = this.stateStore.load();
    if (state.status !== "active_run") {
      return;
    }

    state.status = "manual_intervention_required";
    state.last_run_outcome = "manual_intervention_required";
    state.next_run_at = null;
    this.stateStore.save(state);
    this.clearPollTimer();

    await Promise.resolve(this.callbacks.notifyChannels(
      this.config,
      buildManualInterventionNotification(this.schedulerThreadId, blocker)
    )).catch(() => {});
  }

  private async hasRunningToolProgress(): Promise<boolean> {
    try {
      const report = await buildDispatchStatusReport(this.config.dispatch_plan_path);
      return report.workers.some((worker) => worker.progress?.status === "running");
    } catch {
      return false;
    }
  }

  private resolveServiceContinueWorker(workers: DispatchStatusWorker[]): string | null {
    try {
      const lifecycleState = new LifecycleStore(this.resolveDispatchThreadsPath()).load();
      return resolveServiceContinueWorkerFromWorkerRows(workers, lifecycleState);
    } catch (error) {
      this.log.warn("Scheduler: failed to resolve next worker for continuation", {
        schedulerThreadId: this.schedulerThreadId,
        error: asError(error).message
      });
      return null;
    }
  }

  private recoverCurrentRunOutputEvidence(): void {
    const state = this.stateStore.load();
    if (state.status !== "active_run") {
      return;
    }

    const currentRunReportDir = resolveCurrentRunReportDir(
      state.current_run_report_dir,
      state.current_run_id,
      this.config.report_base_dir
    );
    if (!currentRunReportDir) {
      return;
    }

    const lifecycleStore = new LifecycleStore(this.resolveDispatchThreadsPath());
    const lifecycleState = lifecycleStore.load();
    const planRows = loadPlanRowsByWorker(this.config.dispatch_plan_path);
    const activeProcessCommands = listActiveProcessCommands();
    const nowIso = new Date().toISOString();
    let mutated = false;

    for (const [workerId, worker] of Object.entries(lifecycleState.workers)) {
      if (!isRecoverableOutputStatus(worker)) {
        continue;
      }

      const outputPath = worker.expected_outputs.find((candidate) => {
        return isCurrentRunOutputPath(candidate, currentRunReportDir) && isRecoverableOutputFile(candidate, worker.started_at);
      });
      if (!outputPath) {
        continue;
      }

      const content = readFileIfPresent(outputPath);
      if (content === null) {
        continue;
      }

      if (isWorkerToolProcessRunning(planRows.get(workerId), state.current_scan_run_id, activeProcessCommands)) {
        this.log.debug("Scheduler: skipped output recovery while worker tool process is active", {
          schedulerThreadId: this.schedulerThreadId,
          workerId
        });
        continue;
      }

      const status = classifyRecoveredOutputStatus(content);
      lifecycleState.workers[workerId] = {
        ...worker,
        status,
        last_seen_at: nowIso,
        hub_result: worker.hub_result ?? buildRecoveredOutputHubResult({
          content,
          outputPath,
          source: normalizeAgentType(this.config.agent_type),
          threadId: worker.thread_id,
          traceId: worker.trace_id,
          status,
          timestamp: nowIso
        })
      };
      lifecycleStore.logTransition(workerId, worker.status, status, "scheduler_current_run_output");
      mutated = true;
    }

    if (mutated) {
      lifecycleStore.save(lifecycleState);
    }
  }

  private async cleanupTerminalWorkerThreads(): Promise<void> {
    if (this.config.kill_policy === "never") {
      return;
    }

    let lifecycleState: ReturnType<LifecycleStore["load"]>;
    try {
      lifecycleState = new LifecycleStore(this.resolveDispatchThreadsPath()).load();
    } catch (error) {
      this.log.warn("Scheduler: failed to read dispatch lifecycle for terminal cleanup", {
        schedulerThreadId: this.schedulerThreadId,
        error: asError(error).message
      });
      return;
    }

    const activeThreadIds = new Set<string>();
    for (const worker of Object.values(lifecycleState.workers)) {
      const threadId = normalizeThreadId(worker.thread_id);
      if (threadId && isCleanupBlockingLifecycleStatus(worker.status)) {
        activeThreadIds.add(threadId);
      }
    }

    const attemptedThreadIds = new Set<string>();
    for (const [workerId, worker] of Object.entries(lifecycleState.workers)) {
      const threadId = normalizeThreadId(worker.thread_id);
      if (!threadId || attemptedThreadIds.has(threadId) || this.cleanedTerminalThreadIds.has(threadId)) {
        continue;
      }

      if (activeThreadIds.has(threadId) || !shouldCleanupTerminalWorker(worker, this.config.kill_policy)) {
        continue;
      }

      // Transport-stall cooldown — see watchdog.cleanupTerminalWorkerThreads
      // for the full rationale. Suppresses retry of a kill whose outcome is
      // unknown until the cooldown expires.
      const cooldownUntil = this.cleanupKillTransportCooldownUntilMs.get(threadId);
      if (cooldownUntil !== undefined && this.now() < cooldownUntil) {
        continue;
      }

      attemptedThreadIds.add(threadId);
      try {
        await this.callbacks.killDispatcher(threadId);
        this.cleanedTerminalThreadIds.add(threadId);
        this.cleanupKillTransportCooldownUntilMs.delete(threadId);
      } catch (error) {
        const message = asError(error).message;
        if (isMissingThreadEvidence(message)) {
          this.cleanedTerminalThreadIds.add(threadId);
          this.cleanupKillTransportCooldownUntilMs.delete(threadId);
          continue;
        }

        if (isHubTransportEvidence(message)) {
          const wasInCooldown = this.cleanupKillTransportCooldownUntilMs.has(threadId);
          this.cleanupKillTransportCooldownUntilMs.set(
            threadId,
            this.now() + CLEANUP_KILL_TRANSPORT_COOLDOWN_MS
          );
          if (!wasInCooldown) {
            this.log.info("Scheduler: terminal worker cleanup deferred — hub transport stall", {
              schedulerThreadId: this.schedulerThreadId,
              workerId,
              threadId,
              error: message,
              cooldown_ms: CLEANUP_KILL_TRANSPORT_COOLDOWN_MS
            });
          }
          continue;
        }

        this.log.warn("Scheduler: terminal worker cleanup kill failed", {
          schedulerThreadId: this.schedulerThreadId,
          workerId,
          threadId,
          error: message
        });
      }
    }
  }

  private async continueSchedulerWorker(
    workerId: string,
    workers: DispatchStatusWorker[]
  ): Promise<ContinueDispatchWorkerResult> {
    if (this.callbacks.continueWorker) {
      return this.callbacks.continueWorker(this.config, workerId);
    }

    return continueDispatchWorker(
      this.config,
      workers.map(toContinueDispatchPlanRow),
      workerId
    );
  }

  private isDispatcherControllerRunning(): boolean {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.resolveDispatchThreadsPath(), "utf8")) as {
        workers?: Record<string, { status?: unknown }>;
      };
      return parsed.workers?.[DISPATCHER_WORKER_ID]?.status === "running";
    } catch {
      return false;
    }
  }

  private resolveDispatchThreadsPath(): string {
    return path.join(path.dirname(this.config.dispatch_plan_path), DISPATCH_THREADS_FILENAME);
  }

  private clearTimers(): void {
    this.clearScheduleTimer();
    this.clearPollTimer();
  }

  private clearScheduleTimer(): void {
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }

  private clearPollTimer(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

function toContinueDispatchPlanRow(worker: DispatchStatusWorker): ContinueDispatchPlanRow {
  return {
    status: worker.status,
    worker: worker.worker_id,
    model: worker.model ?? "",
    notes: worker.notes
  };
}

function resolveCurrentRunReportDir(
  persistedReportDir: string | null,
  currentRunId: string | null,
  reportBaseDir: string
): string | null {
  if (persistedReportDir?.trim()) {
    return path.resolve(persistedReportDir);
  }

  const runId = currentRunId?.trim();
  if (!runId) {
    return null;
  }

  return path.resolve(reportBaseDir, "runs", sanitizePathSegment(runId));
}

function isCurrentRunOutputPath(candidatePath: string, currentRunReportDir: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(currentRunReportDir, resolvedCandidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isRecoverableOutputFile(candidatePath: string, workerStartedAt: string | null | undefined): boolean {
  try {
    const stat = fs.statSync(candidatePath);
    if (!stat.isFile() || stat.size <= 0) {
      return false;
    }

    const startedMs = Date.parse(workerStartedAt ?? "");
    return !Number.isFinite(startedMs) || stat.mtimeMs >= startedMs;
  } catch {
    return false;
  }
}

function readFileIfPresent(candidatePath: string): string | null {
  try {
    return fs.readFileSync(candidatePath, "utf8");
  } catch {
    return null;
  }
}

function classifyRecoveredOutputStatus(content: string): Extract<LifecycleStatus, "completed" | "failed" | "blocked"> {
  if (hubResultContainsBlockSignal({ content })) {
    return "blocked";
  }

  if (hubResultContainsFailureSignal({ content }) || isNonCompletionContent(content)) {
    return "failed";
  }

  return "completed";
}

function isRecoverableOutputStatus(worker: DispatchWorkerState): boolean {
  return worker.status === "running" || (worker.status === "failed" && worker.hub_result === null);
}

function buildRecoveredOutputHubResult(options: {
  content: string;
  outputPath: string;
  source: AgentType;
  threadId: string;
  traceId: string | null;
  status: Extract<LifecycleStatus, "completed" | "failed" | "blocked">;
  timestamp: string;
}): HubResult {
  return {
    trace_id: isUuid(options.traceId) ? options.traceId : randomUUID(),
    thread_id: options.threadId,
    source: options.source,
    status: options.status === "completed" ? "success" : "error",
    run_state: "completed",
    content: options.content,
    attachments: [{
      path: options.outputPath,
      filename: path.basename(options.outputPath)
    }],
    timestamp: options.timestamp
  };
}

function normalizeAgentType(value: string): AgentType {
  switch (value) {
    case "claude":
    case "codex":
    case "gemini":
    case "cursor":
      return value;
    default:
      return "codex";
  }
}

function shouldCleanupTerminalWorker(worker: DispatchWorkerState, killPolicy: KillPolicy): boolean {
  if (killPolicy === "never") {
    return false;
  }

  if (worker.status === "completed") {
    return killPolicy === "always" || killPolicy === "on_success";
  }

  if (worker.status === "failed" || worker.status === "blocked" || worker.status === "abandoned" || worker.status === "skipped") {
    return killPolicy === "always";
  }

  return false;
}

function isCleanupBlockingLifecycleStatus(status: LifecycleStatus): boolean {
  return status === "running" || status === "awaiting_validation" || status === "fix_requested";
}

function normalizeThreadId(threadId: string | null | undefined): string | null {
  const normalized = threadId?.trim();
  return normalized ? normalized : null;
}

function isManualInterventionBlocker(worker: DispatchStatusWorker): boolean {
  return worker.status === "❌" || worker.status === "⛔ BLOCKED" || worker.lifecycle_status === "failed" || worker.lifecycle_status === "blocked" || worker.progress?.status === "failed";
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized.length > 0 ? sanitized : "run";
}

function isUuid(value: string | null): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// ─── Notification builders ──────────────────────────────────────────────────

function buildStartNotification(
  schedulerThreadId: string,
  runId: string,
  mode: SchedulerMode,
  plannedStartTime: string | null
): string {
  return [
    `**Scheduler cycle started**`,
    `Scheduler: ${schedulerThreadId}`,
    `Run: ${runId}`,
    `Mode: ${mode}`,
    plannedStartTime ? `Planned: ${plannedStartTime}` : null,
    `Started: ${new Date().toISOString()}`
  ].filter(Boolean).join("\n");
}

function buildCompletionNotification(
  schedulerThreadId: string,
  outcome: TerminalOutcome,
  reportPath: string | null
): string {
  return [
    `**Scheduler cycle completed**`,
    `Scheduler: ${schedulerThreadId}`,
    `Outcome: ${outcome}`,
    reportPath ? `Report: ${reportPath}` : null,
    `Completed: ${new Date().toISOString()}`
  ].filter(Boolean).join("\n");
}

function buildOverlapNotification(
  schedulerThreadId: string,
  plannedStartTime: string | null
): string {
  return [
    `**Scheduler cycle skipped (overlap)**`,
    `Scheduler: ${schedulerThreadId}`,
    `Planned: ${plannedStartTime ?? "now"}`,
    `Reason: Previous run still active`
  ].join("\n");
}

function buildManualInterventionNotification(
  schedulerThreadId: string,
  blocker: DispatchStatusWorker
): string {
  return [
    `**Scheduler manual intervention required**`,
    `Scheduler: ${schedulerThreadId}`,
    `Worker: ${blocker.worker_id}`,
    blocker.failure_reason ? `Reason: ${blocker.failure_reason}` : null,
    `Time: ${new Date().toISOString()}`
  ].filter(Boolean).join("\n");
}

function buildCancelNotification(schedulerThreadId: string): string {
  return [
    `**Scheduler cycle cancelled**`,
    `Scheduler: ${schedulerThreadId}`,
    `Time: ${new Date().toISOString()}`
  ].join("\n");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
