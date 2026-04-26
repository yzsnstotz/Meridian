import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";

import type { SchedulerConfig, SchedulerMode, TerminalOutcome } from "../../types";
import { buildDispatchStatusReport } from "../../tool-gateway/tools/dispatch-status";
import { executeContinueDispatcher } from "../../tool-gateway/tools/continue-dispatcher";
import type { Logger } from "../base-role";
import { SchedulerStateStore } from "./scheduler-state-store";
import { nextCronFire, parseCronExpression } from "./cron-parser";
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
}

export interface SchedulerEngineOptions {
  schedulerThreadId: string;
  config: SchedulerConfig;
  stateStore: SchedulerStateStore;
  callbacks: SchedulerEngineCallbacks;
  log: Logger;
}

export class SchedulerEngine {
  private readonly schedulerThreadId: string;
  private config: SchedulerConfig;
  private readonly stateStore: SchedulerStateStore;
  private readonly callbacks: SchedulerEngineCallbacks;
  private readonly log: Logger;

  private scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  private static readonly POLL_INTERVAL_MS = 30_000;

  constructor(options: SchedulerEngineOptions) {
    this.schedulerThreadId = options.schedulerThreadId;
    this.config = options.config;
    this.stateStore = options.stateStore;
    this.callbacks = options.callbacks;
    this.log = options.log;
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

    const result = await executeContinueDispatcher({ dispatcherId: this.schedulerThreadId });
    if (!result.ok) {
      this.log.warn("Scheduler: continue-dispatcher failed", {
        schedulerThreadId: this.schedulerThreadId,
        error: result.error
      });
      return;
    }

    this.log.info("Scheduler: continued incomplete cycle", {
      schedulerThreadId: this.schedulerThreadId,
      status: (result as { status?: unknown }).status,
      worker: (result as { worker?: unknown }).worker
    });
  }

  private isDispatcherControllerRunning(): boolean {
    try {
      const threadsPath = path.join(path.dirname(this.config.dispatch_plan_path), DISPATCH_THREADS_FILENAME);
      const parsed = JSON.parse(fs.readFileSync(threadsPath, "utf8")) as {
        workers?: Record<string, { status?: unknown }>;
      };
      return parsed.workers?.[DISPATCHER_WORKER_ID]?.status === "running";
    } catch {
      return false;
    }
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
