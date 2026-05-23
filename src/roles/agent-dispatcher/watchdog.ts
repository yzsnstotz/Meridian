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
import { isAgentapiProcessAliveForThread } from "./active-tool-process";
import { autoResolve } from "./auto-resolver";
import { runAutoForceCompleteSweep } from "./auto-force-complete-reconciler";
import {
  isPmResolverLivenessGraceActive,
  isValidatorSpawnBackoffActive,
  LifecycleStore
} from "./lifecycle-store";
import { isHubTransportEvidence, isMissingThreadEvidence } from "./missing-thread";
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
  /**
   * Clock seam for tests. Defaults to `Date.now`. Used to gate the per-thread
   * cooldown that suppresses retries of terminal-kill calls that returned a
   * Hub IPC transport error (kill outcome unknown).
   */
  now?: () => number;
  /**
   * Resolves the base branch (e.g. "main") used by the auto-force-complete
   * sweep to scan for `[<WORKER_ID>]`-prefixed commits as completion evidence.
   * Returning null disables the sweep for that plan. When the dep is omitted,
   * the sweep defaults to "main".
   */
  resolveBaseBranchForDispatchPlan?: (dispatchPlanPath: string) => Promise<string | null>;
  /**
   * Master switch for the auto-force-complete sweep. Default true. Set false
   * during an incident to keep the watchdog running other reconciliation while
   * disabling only the evidence-based promotion path.
   */
  autoForceCompleteEnabled?: boolean;
}

/**
 * Cooldown window between retries when a terminal-kill returned a transport-
 * class error (Hub IPC dropped the response). Long enough that a single
 * sustained Hub-overload window doesn't drive a kill-loop, short enough that
 * recovery is observable. PR #203/#206 used 60s for the validator transport
 * paths; mirror that here.
 */
const CLEANUP_KILL_TRANSPORT_COOLDOWN_MS = 60_000;

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
  private readonly resolveBaseBranchForDispatchPlan:
    | ((dispatchPlanPath: string) => Promise<string | null>)
    | null;
  private readonly autoForceCompleteEnabled: boolean;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private sweepInProgress = false;
  private readonly cleanedTerminalThreadIds = new Set<string>();
  // Per-thread TTL cooldown for transport-class kill failures. Prevents the
  // kill-flood that EPIPE'd the Hub's pino transport on agent-dispatcher-98b73906
  // when the Hub started returning "Server error: IPC request completed without
  // response body" — that string is NOT missing-thread evidence (the kill
  // outcome is unknown), so the sweep would otherwise retry every tick.
  private readonly cleanupKillTransportCooldownUntilMs = new Map<string, number>();
  // Test seam — defaulting to Date.now keeps production behavior intact.
  private readonly now: () => number;

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
    this.now = deps.now ?? Date.now;
    this.resolveBaseBranchForDispatchPlan = deps.resolveBaseBranchForDispatchPlan ?? null;
    this.autoForceCompleteEnabled = deps.autoForceCompleteEnabled ?? true;
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

        await this.reconcilePmResolverLiveness(lifecycleStore, dispatchPlanPath);

        await this.cleanupTerminalWorkerThreads(lifecycleStore, dispatchPlanPath, dispatchPlanPaths);

        if (this.autoForceCompleteEnabled) {
          try {
            await this.runAutoForceCompleteSweep(lifecycleStore, dispatchPlanPath);
          } catch (error) {
            this.log.warn("Auto-force-complete sweep failed", {
              dispatchPlanPath,
              error: asError(error).message
            });
          }
        }

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

  private async runAutoForceCompleteSweep(
    lifecycleStore: LifecycleStore,
    dispatchPlanPath: string
  ): Promise<void> {
    const baseBranch = this.resolveBaseBranchForDispatchPlan
      ? await this.resolveBaseBranchForDispatchPlan(dispatchPlanPath)
      : "main";
    if (!baseBranch) {
      return;
    }
    const report = await runAutoForceCompleteSweep(lifecycleStore, dispatchPlanPath, {
      baseBranch,
      log: this.log
    });
    if (report.promoted.length > 0) {
      this.log.info("Auto-force-complete promoted workers", {
        dispatchPlanPath,
        baseBranch,
        promoted: report.promoted.map((entry) => ({
          worker_id: entry.workerId,
          commit_sha: entry.commitSha
        }))
      });
    }
  }

  /**
   * Steady-state PM resolver liveness reconciliation. Mirrors
   * `findLivePmResolversForWorker` (PR #212) but runs on every watchdog sweep
   * instead of only at the relaunch / duplicate-spawn gate, so a PM resolver
   * killed externally (operator kill via Hub GUI, hub spawn-retry id-swap,
   * etc.) gets evicted from the lifecycle even when nothing has triggered a
   * continue tick. Without this sweep step, the dispatcher AI can be idle
   * (DISPATCHER worker terminal, hub thread alive but quiescent) and the
   * stale `running` PM record sits forever blocking worker relaunch — observed
   * on agent-dispatcher-67f6a3fc W-01 codex_04 (operator killed PM via hub
   * GUI at 13:28:20; relaunch gate never re-probed because no continue tick
   * fired). The orphan-codex guard (`isAgentapiProcessAliveForThread`) keeps
   * the entry if the agentapi socket is still owned by a live codex CLI, so
   * we don't race ahead of a PM that hasn't delivered yet.
   */
  private async reconcilePmResolverLiveness(
    lifecycleStore: LifecycleStore,
    dispatchPlanPath: string
  ): Promise<void> {
    let state: DispatchThreadStateV2;
    try {
      state = lifecycleStore.load();
    } catch (error) {
      this.log.warn("Watchdog: failed to read lifecycle state for PM resolver liveness sweep", {
        dispatchPlanPath,
        error: asError(error).message
      });
      return;
    }

    const runningEntries = (state.pm_resolvers ?? []).filter(
      (entry) => entry.status === "running"
    );
    if (runningEntries.length === 0) {
      return;
    }

    const nowMs = this.now();
    for (const entry of runningEntries) {
      const pmThreadId = entry.thread_id?.trim();
      if (!pmThreadId) {
        continue;
      }

      if (isPmResolverLivenessGraceActive(entry, nowMs)) {
        this.log.info("Watchdog: PM resolver is inside liveness grace; preserving entry", {
          event: "watchdog_pm_resolver_liveness_grace_preserved",
          dispatchPlanPath,
          pm_thread_id: pmThreadId,
          worker_id: entry.issue?.worker_id ?? null,
          started_at: entry.started_at,
          last_seen_at: entry.last_seen_at
        });
        continue;
      }

      // `recordPmResolverTransportStall` (pm-resolver.ts) explicitly retains
      // the thread on a transport-class run rejection (hub overload, request
      // timeout, IPC drop) so the operator can take over via the GUI
      // talk-box. The PM agent never attached, so a hub probe here will
      // always return `missing` and demote to `failed` — letting the
      // watchdog / pm-resolve handler spawn a fresh PM that hits the same
      // overloaded hub and re-stalls. Observed on
      // agent-dispatcher-67f6a3fc V-01-A as a 2-minute PM respawn storm
      // (codex_08→codex_10→codex_11, all on the same `Request timed out —
      // the hub may be overloaded.` rejection). Preserve transport-stalled
      // entries; the operator surfaces `transport_error` in the GUI and
      // resolves via talk-box, retry, or human-resolve.
      if (entry.transport_error) {
        this.log.info("Watchdog: PM resolver transport-stalled; preserving entry for human takeover", {
          event: "watchdog_pm_resolver_transport_stall_preserved",
          dispatchPlanPath,
          pm_thread_id: pmThreadId,
          worker_id: entry.issue?.worker_id ?? null,
          transport_error: entry.transport_error
        });
        continue;
      }

      let observationKind: "missing" | "failed" | "running" | "idle" | "completed";
      try {
        const observation = await queryHubThreadObservation(this.hubClient, pmThreadId);
        observationKind = observation.kind;
      } catch (error) {
        this.log.warn("Watchdog: PM resolver liveness probe failed", {
          event: "watchdog_pm_resolver_liveness_probe_error",
          dispatchPlanPath,
          pm_thread_id: pmThreadId,
          worker_id: entry.issue?.worker_id ?? null,
          error: asError(error).message
        });
        continue;
      }

      if (observationKind !== "missing" && observationKind !== "failed") {
        continue;
      }

      if (isAgentapiProcessAliveForThread(pmThreadId)) {
        this.log.warn("Watchdog: PM resolver missing from hub registry but agentapi process is still alive; preserving entry", {
          event: "watchdog_pm_resolver_hub_missing_codex_alive",
          dispatchPlanPath,
          pm_thread_id: pmThreadId,
          worker_id: entry.issue?.worker_id ?? null,
          observed_status: observationKind
        });
        continue;
      }

      const reason = `watchdog_pm_thread_missing: hub_status=${observationKind}`;
      lifecycleStore.markPmResolverThreadMissing(pmThreadId, reason);
      this.log.info("Watchdog: evicted stale PM resolver thread from lifecycle", {
        event: "watchdog_pm_resolver_evicted",
        dispatchPlanPath,
        pm_thread_id: pmThreadId,
        worker_id: entry.issue?.worker_id ?? null,
        observed_status: observationKind
      });
    }
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
    dispatchPlanPath: string,
    allDispatchPlanPaths: readonly string[]
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
    // The Hub recycles freed thread_ids across the whole service, not per
    // dispatch plan. PR #155 reserved validator/worker threads against the
    // current plan's own terminal rows; this extends the same protection
    // across every active plan the watchdog sweeps. Without it, plan B's
    // stale terminal row pointing at a recycled id will kill plan A's live
    // validator/worker. Observed dispatcher 9fd97803 C-11 codex_38 killed
    // by hgd-growth-v1 BATCH-2-GATE stale row, producing a duplicate cycle
    // 3 spawn (codex_39) and a regression score that put C-11 back to running.
    const crossPlanActiveThreadIds = this.collectCrossPlanActiveThreadIds(
      dispatchPlanPath,
      allDispatchPlanPaths
    );

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
      if (activeThreadIds.has(threadId) || crossPlanActiveThreadIds.has(threadId)) {
        continue;
      }
      if (!shouldKillTerminalWorker(killPolicy, worker)) {
        continue;
      }

      // Transport-stall cooldown: a prior kill on this thread returned a Hub
      // IPC transport error (kill outcome unknown). Skip silently until the
      // window expires; the next attempt will either succeed, return
      // missing-thread evidence (target really was killed), or refresh the
      // cooldown. Without this, sustained Hub overload turns a single
      // dropped response body into a per-tick kill loop that floods the log
      // and EPIPE's the Hub's pino transport (315k entries observed on
      // 2026-05-19).
      const cooldownUntil = this.cleanupKillTransportCooldownUntilMs.get(threadId);
      if (cooldownUntil !== undefined && this.now() < cooldownUntil) {
        continue;
      }

      attemptedThreadIds.add(threadId);
      try {
        await this.killThread(threadId);
        this.cleanedTerminalThreadIds.add(threadId);
        this.cleanupKillTransportCooldownUntilMs.delete(threadId);
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
            this.log.info("Watchdog: terminal worker cleanup deferred — hub transport stall", {
              dispatchPlanPath,
              worker_id: workerId,
              thread_id: threadId,
              error: message,
              cooldown_ms: CLEANUP_KILL_TRANSPORT_COOLDOWN_MS
            });
          }
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

  private collectCrossPlanActiveThreadIds(
    excludeDispatchPlanPath: string,
    allDispatchPlanPaths: readonly string[]
  ): Set<string> {
    const ids = new Set<string>();
    for (const otherPath of allDispatchPlanPaths) {
      if (otherPath === excludeDispatchPlanPath) {
        continue;
      }
      try {
        const otherState = new LifecycleStore(resolveDispatchThreadPath(otherPath)).load();
        const dispatcherThreadId = otherState.dispatcher.thread_id?.trim();
        if (dispatcherThreadId && otherState.dispatcher.status === "running") {
          ids.add(dispatcherThreadId);
        }
        for (const id of collectCleanupBlockingThreadIds(otherState)) {
          ids.add(id);
        }
      } catch (error) {
        this.log.warn("Watchdog: failed to read cross-plan lifecycle for cleanup reservation", {
          dispatchPlanPath: otherPath,
          error: asError(error).message
        });
      }
    }
    return ids;
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
          const dispatcherControllerIdle = hasTerminalDispatcherControllerTurn(state);
          if (
            !pendingValidationOrchestration
            && !isStaleSyntheticDispatcherWorker(state, this.now())
            && !dispatcherControllerIdle
          ) {
            return;
          }

          dispatcherStatus = pendingValidationOrchestration
            ? "running_validation_pending"
            : dispatcherControllerIdle
              ? "running_controller_idle"
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

function hasTerminalDispatcherControllerTurn(state: DispatchThreadStateV2): boolean {
  const dispatcherWorker = state.workers[DISPATCHER_WORKER_ID];
  if (!dispatcherWorker) {
    return false;
  }

  return dispatcherWorker.status === "completed"
    || dispatcherWorker.status === "failed"
    || dispatcherWorker.status === "blocked"
    || dispatcherWorker.status === "abandoned"
    || dispatcherWorker.status === "skipped";
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
    if (
      threadId
      && (
        worker.status === "running"
        || worker.status === "awaiting_validation"
        || worker.status === "fix_requested"
        || worker.status === "blocked"
      )
    ) {
      ids.add(threadId);
    }
    // Validator threads are alive while the worker is awaiting_validation /
    // fix_requested. The Hub recycles freed thread_ids, so a stale row on a
    // terminal worker (e.g. N-07 status=completed, thread_id=codex_09) can
    // collide with a freshly spawned validator that the lifecycle now records
    // as `validation.validator_thread_id`. Without this guard, terminal-thread
    // cleanup kills the active validator and the next continue tick spawns a
    // second one (the "double validator" symptom — observed dispatcher
    // 02972423: N-39 validator codex_09 killed mid-cycle, codex_10 respawned).
    // Mirrors thread-id-reservation.isThreadIdReservedInLifecycleState, which
    // already protects validator threads on the spawn-side collision check.
    const validatorThreadId = worker.validation?.validator_thread_id?.trim();
    if (
      validatorThreadId
      && (worker.status === "awaiting_validation" || worker.status === "fix_requested")
    ) {
      ids.add(validatorThreadId);
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

async function defaultKillThread(threadId: string): Promise<void> {
  const result = await killTool.execute({ thread_id: threadId });
  if (!result.ok) {
    throw new Error(result.error ?? `kill failed for thread ${threadId}`);
  }
}
