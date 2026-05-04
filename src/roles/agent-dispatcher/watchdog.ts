import * as fs from "node:fs/promises";
import path from "node:path";

import type { A2AClient } from "../../a2a/client";
import { RECONCILE_INTERVAL_MS } from "../../config";
import killTool from "../../tool-gateway/tools/kill";
import { parseDispatchPlanRows } from "../../tool-gateway/tools/dispatch-status";
import type {
  AutoResolveConfig,
  DispatchThreadStateV2,
  DispatchWorkerState,
  KillPolicy
} from "../../types";
import type { Logger } from "../base-role";
import { autoResolve } from "./auto-resolver";
import { isValidatorSpawnBackoffActive, LifecycleStore } from "./lifecycle-store";
import {
  DEFAULT_RECONCILE_STALE_TIMEOUT_MS,
  queryHubThreadObservation,
  reconcile,
  type ReconciliationReport
} from "./reconciler";
import {
  countEligiblePendingServiceContinueWorkersFromWorkerRows,
  isHumanDispatchRow,
  resolveManualInterventionWorkerFromWorkerRows,
  resolveServiceContinueWorkerFromWorkerRows
} from "./service-continuation";

const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";
const DISPATCHER_WORKER_ID = "DISPATCHER";

export interface DispatcherStallInfo {
  dispatchPlanPath: string;
  dispatcherStatus: string;
  pendingWorkerCount: number;
  continueWorkerId: string | null;
}

export interface WatchdogDeps {
  resolveActiveDispatchPlanPaths: () => Promise<string[]>;
  hubClient: A2AClient;
  log: Logger;
  intervalMs?: number;
  onDispatcherStalled?: (info: DispatcherStallInfo) => Promise<void>;
  isDispatcherPaused?: (dispatchPlanPath: string) => Promise<boolean>;
  autoResolveConfig?: AutoResolveConfig;
  /**
   * Resolves the configured kill_policy for the dispatcher that owns the given
   * dispatch_plan_path. Returning null disables terminal-thread cleanup for
   * that plan (e.g. when the role config cannot be located).
   */
  resolveKillPolicyForDispatchPlan?: (dispatchPlanPath: string) => Promise<KillPolicy | null>;
  /**
   * Issues a kill against the Meridian Hub for a worker thread. Defaults to
   * the in-process `killTool` so production wires through the same transport
   * the run-tool's terminal cleanup uses.
   */
  killThread?: (threadId: string) => Promise<void>;
}

export class ReconciliationWatchdog {
  private readonly resolveActiveDispatchPlanPaths: () => Promise<string[]>;
  private readonly hubClient: A2AClient;
  private readonly log: Logger;
  private readonly intervalMs: number;
  private readonly onDispatcherStalled: ((info: DispatcherStallInfo) => Promise<void>) | null;
  private readonly isDispatcherPaused: ((dispatchPlanPath: string) => Promise<boolean>) | null;
  private readonly autoResolveConfig: AutoResolveConfig | null;
  private readonly resolveKillPolicyForDispatchPlan:
    | ((dispatchPlanPath: string) => Promise<KillPolicy | null>)
    | null;
  private readonly killThread: (threadId: string) => Promise<void>;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private sweepInProgress = false;
  private readonly cleanedTerminalThreadIds = new Set<string>();

  constructor(deps: WatchdogDeps) {
    this.resolveActiveDispatchPlanPaths = deps.resolveActiveDispatchPlanPaths;
    this.hubClient = deps.hubClient;
    this.log = deps.log;
    this.intervalMs = deps.intervalMs ?? RECONCILE_INTERVAL_MS;
    this.onDispatcherStalled = deps.onDispatcherStalled ?? null;
    this.isDispatcherPaused = deps.isDispatcherPaused ?? null;
    this.autoResolveConfig = deps.autoResolveConfig ?? null;
    this.resolveKillPolicyForDispatchPlan = deps.resolveKillPolicyForDispatchPlan ?? null;
    this.killThread = deps.killThread ?? defaultKillThread;
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;

    if (this.intervalMs <= 0) {
      this.log.info("Reconciliation watchdog disabled (interval <= 0)");
      return;
    }

    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    this.timer.unref();

    this.log.info("Reconciliation watchdog started", {
      intervalMs: this.intervalMs
    });
  }

  stop(): void {
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sweep(): Promise<ReconciliationReport[]> {
    if (this.sweepInProgress) {
      return [];
    }

    this.sweepInProgress = true;

    try {
      return await this.runSweep();
    } finally {
      this.sweepInProgress = false;
    }
  }

  private async runSweep(): Promise<ReconciliationReport[]> {
    let dispatchPlanPaths: string[];

    try {
      dispatchPlanPaths = await this.resolveActiveDispatchPlanPaths();
    } catch (error) {
      this.log.warn("Watchdog failed to resolve active dispatch plans", {
        error: asError(error).message
      });
      return [];
    }

    if (dispatchPlanPaths.length === 0) {
      return [];
    }

    const reports: ReconciliationReport[] = [];

    for (const dispatchPlanPath of dispatchPlanPaths) {
      try {
        const lifecycleStore = new LifecycleStore(
          resolveDispatchThreadPath(dispatchPlanPath)
        );
        const report = await reconcile(lifecycleStore, this.hubClient);

        if (report.changed.length > 0) {
          this.log.info("Watchdog reconciliation detected changes", {
            dispatchPlanPath,
            changes: report.changed.map((change) => ({
              workerId: change.workerId,
              from: change.from,
              to: change.to,
              trigger: change.trigger
            }))
          });
        }

        reports.push(report);

        await this.cleanupTerminalWorkerThreads(lifecycleStore, dispatchPlanPath);

        if (this.autoResolveConfig) {
          try {
            const resolveReport = await autoResolve(
              lifecycleStore,
              dispatchPlanPath,
              this.autoResolveConfig,
              {
                log: this.log,
                writeWorkerFile: async (filePath, content) => {
                  await fs.mkdir(path.dirname(filePath), { recursive: true });
                  await fs.writeFile(filePath, content, "utf8");
                }
              }
            );

            if (resolveReport.generated.length > 0 || resolveReport.retried.length > 0 || resolveReport.escalated.length > 0) {
              this.log.info("Auto-resolve completed", {
                dispatchPlanPath,
                generated: resolveReport.generated.map((g) => g.fixWorkerId),
                retried: resolveReport.retried,
                escalated: resolveReport.escalated
              });
            }
          } catch (error) {
            this.log.warn("Auto-resolve failed", {
              dispatchPlanPath,
              error: asError(error).message
            });
          }
        }

        await this.checkForStalledDispatcher(lifecycleStore, dispatchPlanPath);
      } catch (error) {
        this.log.warn("Watchdog reconciliation failed for dispatch plan", {
          dispatchPlanPath,
          error: asError(error).message
        });
      }
    }

    return reports;
  }
  /**
   * Enforce kill_policy for any worker that has settled into a terminal
   * lifecycle status with a still-recorded thread id. The run-tool's
   * `cleanupWorkerThread` only runs in its success path; when the run-tool
   * HTTP call to the Hub times out (or otherwise errors transiently), the
   * worker is left in "running" and the watchdog reconciler is what later
   * transitions it to "completed" via marker observation. Without this
   * cleanup, those worker threads outlive their work.
   */
  private async cleanupTerminalWorkerThreads(
    lifecycleStore: LifecycleStore,
    dispatchPlanPath: string
  ): Promise<void> {
    if (!this.resolveKillPolicyForDispatchPlan) {
      return;
    }

    let killPolicy: KillPolicy | null;
    try {
      killPolicy = await this.resolveKillPolicyForDispatchPlan(dispatchPlanPath);
    } catch (error) {
      this.log.warn("Watchdog: failed to resolve kill_policy for terminal cleanup", {
        dispatchPlanPath,
        error: asError(error).message
      });
      return;
    }

    if (!killPolicy || killPolicy === "never") {
      return;
    }

    let lifecycleState: DispatchThreadStateV2;
    try {
      lifecycleState = lifecycleStore.load();
    } catch (error) {
      this.log.warn("Watchdog: failed to read lifecycle state for terminal cleanup", {
        dispatchPlanPath,
        error: asError(error).message
      });
      return;
    }

    const dispatcherThreadId = lifecycleState.dispatcher.thread_id?.trim() ?? "";
    const activeThreadIds = collectCleanupBlockingThreadIds(lifecycleState);

    const attemptedThreadIds = new Set<string>();
    for (const [workerId, worker] of Object.entries(lifecycleState.workers)) {
      if (workerId === DISPATCHER_WORKER_ID) {
        continue;
      }

      const threadId = worker.thread_id?.trim();
      if (!threadId) {
        continue;
      }
      if (attemptedThreadIds.has(threadId) || this.cleanedTerminalThreadIds.has(threadId)) {
        continue;
      }
      // Never kill the dispatcher controller's own thread, even if a worker
      // (briefly) shares the recorded id during a state transition.
      if (threadId === dispatcherThreadId) {
        continue;
      }
      if (activeThreadIds.has(threadId)) {
        continue;
      }
      if (!shouldKillTerminalWorker(killPolicy, worker)) {
        continue;
      }

      attemptedThreadIds.add(threadId);
      try {
        await this.killThread(threadId);
        this.cleanedTerminalThreadIds.add(threadId);
        this.log.info("Watchdog: terminal worker thread killed", {
          event: "watchdog_terminal_kill",
          dispatchPlanPath,
          worker_id: workerId,
          thread_id: threadId,
          worker_status: worker.status,
          kill_policy: killPolicy
        });
      } catch (error) {
        const message = asError(error).message;
        if (isMissingThreadCleanupError(message)) {
          this.cleanedTerminalThreadIds.add(threadId);
          continue;
        }
        this.log.warn("Watchdog: terminal worker cleanup kill failed", {
          dispatchPlanPath,
          worker_id: workerId,
          thread_id: threadId,
          error: message
        });
      }
    }
  }

  private async checkForStalledDispatcher(
    lifecycleStore: LifecycleStore,
    dispatchPlanPath: string
  ): Promise<void> {
    if (!this.onDispatcherStalled) {
      return;
    }

    if (this.isDispatcherPaused) {
      try {
        if (await this.isDispatcherPaused(dispatchPlanPath)) {
          return;
        }
      } catch (error) {
        this.log.warn("Watchdog failed to check dispatcher pause state", {
          dispatchPlanPath,
          error: asError(error).message
        });
      }
    }

    const state = lifecycleStore.load();
    const { pendingWorkerCount, continueWorkerId } = await resolveRecoverableWorkerState(dispatchPlanPath, state);
    if (pendingWorkerCount === 0 && !continueWorkerId) {
      return;
    }

    const blockingRunningWorkers = resolveBlockingRunningWorkers(state, continueWorkerId);
    if (blockingRunningWorkers.length > 0) {
      return;
    }

    let dispatcherStatus: string = state.dispatcher.status;
    if (state.dispatcher.status === "running") {
      try {
        const observation = await queryHubThreadObservation(this.hubClient, state.dispatcher.thread_id);
        if (observation.kind === "running") {
          // Validator orchestration is server-driven via the continueDispatcher
          // API, not by the hub session itself. A hub thread that reports
          // "running" can simply be alive-but-idle after emitting a final
          // reply. If a worker is sitting in awaiting_validation with no
          // validator spawned (or fix_requested with the retained worker
          // thread cleared for relaunch), the hub will not move it forward —
          // only a continueDispatcher tick will. Fall through to fire the
          // stall callback in those cases instead of returning.
          const pendingValidationOrchestration = hasPendingValidatorOrchestration(state);
          if (!pendingValidationOrchestration && !isStaleSyntheticDispatcherWorker(state, Date.now())) {
            return;
          }

          dispatcherStatus = pendingValidationOrchestration
            ? "running_validation_pending"
            : "running_stale";
        } else {
          dispatcherStatus = observation.rawStatus ?? observation.kind;
        }
      } catch (error) {
        this.log.warn("Watchdog failed to probe running dispatcher before stall recovery", {
          dispatchPlanPath,
          dispatcherThreadId: state.dispatcher.thread_id,
          error: asError(error).message
        });
        return;
      }
    }

    this.log.info("Watchdog detected stalled dispatcher with recoverable workers", {
      dispatchPlanPath,
      dispatcherStatus,
      pendingWorkerCount,
      continueWorkerId
    });

    try {
      await this.onDispatcherStalled({
        dispatchPlanPath,
        dispatcherStatus,
        pendingWorkerCount,
        continueWorkerId
      });
    } catch (error) {
      this.log.warn("Watchdog dispatcher stall callback failed", {
        dispatchPlanPath,
        error: asError(error).message
      });
    }
  }
}

function countWorkersInStatus(state: DispatchThreadStateV2, status: string): number {
  return Object.values(state.workers).filter((worker) => worker.status === status).length;
}

function resolveBlockingRunningWorkers(
  state: DispatchThreadStateV2,
  continueWorkerId: string | null
): string[] {
  return Object.entries(state.workers)
    .filter(([workerId]) => workerId !== DISPATCHER_WORKER_ID)
    .filter(([, worker]) => worker.status === "running")
    .filter(([workerId, worker]) => workerId !== continueWorkerId || worker.thread_id.trim().length > 0)
    .map(([workerId]) => workerId);
}

function hasPendingValidatorOrchestration(state: DispatchThreadStateV2): boolean {
  const nowMs = Date.now();
  return Object.entries(state.workers).some(([workerId, worker]) => {
    if (workerId === DISPATCHER_WORKER_ID) {
      return false;
    }

    if (worker.status === "awaiting_validation") {
      if (worker.validation?.validator_thread_id?.trim()) {
        return false;
      }
      // Worker has had repeated validator spawn/run failures; honor the
      // backoff window instead of firing the stall callback every tick.
      // Without this, a broken spawn transport (e.g. codex cwd not trusted)
      // produces a tight retry loop that exhausts Hub/system file descriptors.
      if (isValidatorSpawnBackoffActive(worker.validation, nowMs)) {
        return false;
      }
      return true;
    }

    if (worker.status === "fix_requested") {
      // Validator feedback delivery is server-driven via continueDispatcher,
      // not by the dispatcher hub session. A retained worker thread_id does
      // not mean the hub will push feedback on its own — only a tick will.
      // After a service or hub bounce, the recorded thread_id may also be
      // stale (dead in the hub); processValidationQueue Phase 3 detects that
      // by attempting delivery, and on failure clears the thread for relaunch.
      // Both branches need the watchdog to fire when the hub reports running
      // but is idle, so always treat fix_requested as pending here.
      return true;
    }

    return false;
  });
}

function isStaleSyntheticDispatcherWorker(state: DispatchThreadStateV2, nowMs: number): boolean {
  const dispatcherWorker = state.workers[DISPATCHER_WORKER_ID];
  if (!dispatcherWorker || dispatcherWorker.status !== "running") {
    return false;
  }

  return isStaleTimestamp(
    dispatcherWorker.last_seen_at || dispatcherWorker.started_at,
    nowMs,
    DEFAULT_RECONCILE_STALE_TIMEOUT_MS
  );
}

function isStaleTimestamp(value: string, nowMs: number, staleTimeoutMs: number): boolean {
  const valueMs = Date.parse(value);
  if (Number.isNaN(valueMs)) {
    return false;
  }

  return nowMs - valueMs >= staleTimeoutMs;
}

async function resolveRecoverableWorkerState(
  dispatchPlanPath: string,
  state: DispatchThreadStateV2
): Promise<{ pendingWorkerCount: number; continueWorkerId: string | null }> {
  try {
    const markdown = await fs.readFile(dispatchPlanPath, "utf8");
    const rows = parseDispatchPlanRows(markdown);
    const continueWorkerId = resolveServiceContinueWorkerFromWorkerRows(rows, state)
      ?? resolveValidationContinueWorkerFromWorkerRows(rows, state)
      ?? resolveManualInterventionWorkerFromWorkerRows(rows, state);
    return {
      pendingWorkerCount: countEligiblePendingServiceContinueWorkersFromWorkerRows(rows, state),
      continueWorkerId
    };
  } catch {
    return {
      pendingWorkerCount: countWorkersInStatus(state, "pending"),
      continueWorkerId: null
    };
  }
}

function resolveValidationContinueWorkerFromWorkerRows(
  rows: ReturnType<typeof parseDispatchPlanRows>,
  state: DispatchThreadStateV2
): string | null {
  for (const row of rows) {
    const workerId = row.worker_id.trim();
    if (!workerId || isHumanDispatchRow(row)) {
      continue;
    }

    const worker = state.workers[workerId];
    if (!worker) {
      continue;
    }

    if (worker.status === "fix_requested") {
      return workerId;
    }

    if (worker.status === "awaiting_validation" && !worker.validation?.validator_thread_id?.trim()) {
      return workerId;
    }
  }

  return null;
}

function resolveDispatchThreadPath(dispatchPlanPath: string): string {
  return path.join(path.dirname(dispatchPlanPath), DISPATCH_THREADS_FILENAME);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function collectCleanupBlockingThreadIds(state: DispatchThreadStateV2): Set<string> {
  const ids = new Set<string>();
  for (const worker of Object.values(state.workers)) {
    const threadId = worker.thread_id?.trim();
    if (!threadId) {
      continue;
    }
    if (
      worker.status === "running"
      || worker.status === "awaiting_validation"
      || worker.status === "fix_requested"
    ) {
      ids.add(threadId);
    }
  }
  return ids;
}

function shouldKillTerminalWorker(killPolicy: KillPolicy, worker: DispatchWorkerState): boolean {
  if (killPolicy === "never") {
    return false;
  }
  if (worker.status === "completed") {
    return killPolicy === "always" || killPolicy === "on_success";
  }
  if (
    worker.status === "failed"
    || worker.status === "blocked"
    || worker.status === "abandoned"
    || worker.status === "skipped"
  ) {
    return killPolicy === "always";
  }
  return false;
}

function isMissingThreadCleanupError(message: string): boolean {
  return /\bnot found\b/i.test(message)
    || /\bmissing\b/i.test(message)
    || /\bunknown thread\b/i.test(message);
}

async function defaultKillThread(threadId: string): Promise<void> {
  const result = await killTool.execute({ thread_id: threadId });
  if (!result.ok) {
    throw new Error(result.error ?? `kill failed for thread ${threadId}`);
  }
}
