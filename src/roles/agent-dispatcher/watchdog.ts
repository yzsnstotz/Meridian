import * as fs from "node:fs/promises";
import path from "node:path";

import type { A2AClient } from "../../a2a/client";
import { RECONCILE_INTERVAL_MS } from "../../config";
import { parseDispatchPlanRows } from "../../tool-gateway/tools/dispatch-status";
import type { DispatchThreadStateV2 } from "../../types";
import type { Logger } from "../base-role";
import { LifecycleStore } from "./lifecycle-store";
import { queryHubThreadObservation, reconcile, type ReconciliationReport } from "./reconciler";
import { resolveServiceContinueWorkerFromWorkerRows } from "./service-continuation";

const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";

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
}

export class ReconciliationWatchdog {
  private readonly resolveActiveDispatchPlanPaths: () => Promise<string[]>;
  private readonly hubClient: A2AClient;
  private readonly log: Logger;
  private readonly intervalMs: number;
  private readonly onDispatcherStalled: ((info: DispatcherStallInfo) => Promise<void>) | null;
  private readonly isDispatcherPaused: ((dispatchPlanPath: string) => Promise<boolean>) | null;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private sweepInProgress = false;

  constructor(deps: WatchdogDeps) {
    this.resolveActiveDispatchPlanPaths = deps.resolveActiveDispatchPlanPaths;
    this.hubClient = deps.hubClient;
    this.log = deps.log;
    this.intervalMs = deps.intervalMs ?? RECONCILE_INTERVAL_MS;
    this.onDispatcherStalled = deps.onDispatcherStalled ?? null;
    this.isDispatcherPaused = deps.isDispatcherPaused ?? null;
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
          return;
        }

        dispatcherStatus = observation.rawStatus ?? observation.kind;
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
    .filter(([, worker]) => worker.status === "running")
    .filter(([workerId, worker]) => workerId !== continueWorkerId || worker.thread_id.trim().length > 0)
    .map(([workerId]) => workerId);
}

async function resolveRecoverableWorkerState(
  dispatchPlanPath: string,
  state: DispatchThreadStateV2
): Promise<{ pendingWorkerCount: number; continueWorkerId: string | null }> {
  try {
    const markdown = await fs.readFile(dispatchPlanPath, "utf8");
    const rows = parseDispatchPlanRows(markdown);
    return {
      pendingWorkerCount: rows.filter((row) => row.status === "⬜" && !isHumanOwnedModel(row.model)).length,
      continueWorkerId: resolveServiceContinueWorkerFromWorkerRows(rows, state)
    };
  } catch {
    return {
      pendingWorkerCount: countWorkersInStatus(state, "pending"),
      continueWorkerId: null
    };
  }
}

function isHumanOwnedModel(model: string | null): boolean {
  const normalized = typeof model === "string" ? model.trim().toUpperCase() : "";
  return normalized === "HUMAN" || normalized === "PM";
}

function resolveDispatchThreadPath(dispatchPlanPath: string): string {
  return path.join(path.dirname(dispatchPlanPath), DISPATCH_THREADS_FILENAME);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
