import * as fs from "node:fs/promises";
import path from "node:path";

import type { A2AClient } from "../../a2a/client";
import { isDispatchAutoParallelEnabled, RECONCILE_INTERVAL_MS } from "../../config";
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
  countPmResolverTransportStallDemotions,
  isPmResolverLivenessGraceActive,
  isPmResolverNoProgressStale,
  isValidatorSpawnBackoffActive,
  isWorkerHeartbeatStale,
  LifecycleStore,
  PM_RESOLVER_NO_PROGRESS_ERROR_PREFIX,
  PM_RESOLVER_NO_PROGRESS_STALE_MS,
  PM_RESOLVER_TRANSPORT_STALL_GRACE_MS,
  PM_RESOLVER_TRANSPORT_STALL_MAX_RETRIES,
  WORKER_HEARTBEAT_STALE_THRESHOLD_MS
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
  resolveExhaustedPmResolverWorkersFromWorkerRows,
  resolveHumanEscalationParkedWorkersFromWorkerRows,
  resolveManualInterventionWorkerFromWorkerRows,
  resolveServiceContinueWorkerFromWorkerRows
} from "./service-continuation";
import { resolveOccupiedParallelSlots } from "./slot-occupancy";
import {
  isFrozenPendingHumanResolution,
  type HumanEscalationFreeze
} from "./human-escalation-freeze";
import {
  createCapsuleMaterializationGate,
  resolveCapsuleMaterializationParkedWorkers,
  type CapsuleMaterializationGate,
  type CapsuleMaterializationHold
} from "./capsule-materialization";

const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";
const DISPATCHER_WORKER_ID = "DISPATCHER";
/**
 * How often `dispatcher_awaiting_human_resolution` re-fires for the same parked
 * (plan, worker, escalation). 15 minutes: frequent enough that an operator
 * tailing the log within any reasonable window sees it, sparse enough that a
 * multi-hour park costs a handful of lines rather than one per sweep.
 */
const AWAITING_HUMAN_RESOLUTION_HEARTBEAT_MS = 15 * 60 * 1000;
/**
 * Same cadence, same reasoning, for `dispatcher_awaiting_materialization`. A row
 * parked on a capsule that is still `⏳ 待物化` is invisible without it: the
 * markdown reads ⬜ and the lifecycle reads `pending`, which is exactly how
 * I-02..I-06 looked while five workers and five PM resolvers were spent on them.
 */
const AWAITING_MATERIALIZATION_HEARTBEAT_MS = 15 * 60 * 1000;

export interface DispatcherStallInfo {
  dispatchPlanPath: string;
  dispatcherStatus: string;
  pendingWorkerCount: number;
  continueWorkerId: string | null;
  /**
   * True only for the parallel slot-fill path: `parallel_dispatch.max_concurrency`
   * leaves free slots and there is DAG-ready pending work to put in them.
   * `continueWorkerId` is always null here — that is what makes
   * continueDispatcherForRole take its `isParallelAutoContinue` branch.
   *
   * The handler must treat this as "issue a bare continue and stop": it must
   * NOT fall through to relaunching the dispatcher hub session or reactivating
   * the role. Whether stall recovery still gets a turn is decided on the
   * WATCHDOG side, not here — the `mode: "idle"` call site simply keeps going
   * after the callback returns and fires a second, ordinary stall report if
   * nothing was launched. Keeping that decision out of the handler is what
   * lets the handler stay a single unconditional "bare continue then return".
   */
  parallelSlotFill?: boolean;
}

export interface WatchdogParallelDispatchInfo {
  enabled: boolean;
  maxConcurrency: number;
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
  /**
   * Resolves the owning dispatcher's `parallel_dispatch` config for a plan.
   * Only consumed by the parallel slot-fill path; when omitted (or returning
   * null / disabled) the watchdog behaves exactly as it did before that path
   * existed, so every non-parallel dispatcher is untouched.
   */
  resolveParallelDispatchForPlan?: (
    dispatchPlanPath: string
  ) => Promise<WatchdogParallelDispatchInfo | null>;
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
  private readonly resolveParallelDispatchForPlan:
    | ((dispatchPlanPath: string) => Promise<WatchdogParallelDispatchInfo | null>)
    | null;

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
  // One-shot dedup so a dispatcher whose recovery is permanently exhausted
  // (PM resolver failed or escalated to a human and the per-issue dedup
  // prevents respawn) emits `dispatcher_pm_resolver_exhausted` once per
  // `(dispatchPlanPath, workerId)` instead of every interval. Cleared
  // automatically when the predicate stops flagging the key — so a PM
  // re-spawn or operator unblock re-arms the log on the next regression.
  private readonly loggedExhaustedPmResolverKeys = new Set<string>();
  // Heartbeat throttle for `dispatcher_awaiting_human_resolution`. Unlike the
  // one-shot dedup above this RE-EMITS on an interval: a row parked behind an
  // unreleased `escalate_human` can sit for hours, and a single line at minute
  // zero scrolls out of view long before anyone looks. Keyed by
  // `(dispatchPlanPath, workerId, escalatedAt)` so a fresh escalation always
  // logs immediately, and cleared when the row stops being parked.
  private readonly loggedAwaitingHumanResolutionAtMs = new Map<string, number>();
  // Same heartbeat throttle for `dispatcher_awaiting_materialization`, keyed by
  // `(dispatchPlanPath, workerId, reason)` so a row that moves from
  // `awaiting_dependencies` to `awaiting_pm` logs immediately rather than
  // waiting out the interval — that transition is exactly the moment a human
  // acquires something to do.
  private readonly loggedAwaitingMaterializationAtMs = new Map<string, number>();
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
    this.resolveParallelDispatchForPlan = deps.resolveParallelDispatchForPlan ?? null;
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

        await this.reconcileWorkerHeartbeats(lifecycleStore, dispatchPlanPath);

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

      // `recordPmResolverTransportStall` (pm-resolver.ts) retains the thread
      // on a transport-class run rejection (hub overload, request timeout,
      // IPC drop) so the operator can take over via the GUI talk-box.
      // Originally the watchdog preserved transport-stalled entries
      // indefinitely; that left rounds wedged for hours when nobody noticed
      // the GUI prompt (see r10 codex_936, r25 codex_1122 from the
      // 2026-06-05 stuck-recovery handoff). The bounded demotion below
      // restores progress without re-introducing the original respawn storm:
      //
      //   1. Per entry, give the run `PM_RESOLVER_TRANSPORT_STALL_GRACE_MS`
      //      to recover or for an operator to take over.
      //   2. After the grace, count prior watchdog-driven demotions for the
      //      same workerId. While under
      //      `PM_RESOLVER_TRANSPORT_STALL_MAX_RETRIES`, demote so the
      //      dispatcher can spawn a fresh PM that hits a (hopefully) healthier
      //      hub window.
      //   3. Once the cap is hit, revert to the original behavior — preserve
      //      the entry, surface `transport_error` to the GUI, and let the
      //      exhausted-PM-resolver detector page the operator.
      //
      // The cap matters: agent-dispatcher-67f6a3fc V-01-A produced a
      // codex_08→codex_10→codex_11 respawn storm against an overloaded hub.
      // Bounded retries (3 by default) drain the wedge in real recovery
      // scenarios without re-introducing that pathology.
      if (entry.transport_error) {
        const lastSeenMs = Date.parse(entry.last_seen_at);
        const elapsedMs = Number.isNaN(lastSeenMs) ? Infinity : nowMs - lastSeenMs;
        const transportError = entry.transport_error;
        if (elapsedMs < PM_RESOLVER_TRANSPORT_STALL_GRACE_MS) {
          this.log.info("Watchdog: PM resolver transport-stalled, inside grace window", {
            event: "watchdog_pm_resolver_transport_stall_grace_preserved",
            dispatchPlanPath,
            pm_thread_id: pmThreadId,
            worker_id: entry.issue?.worker_id ?? null,
            elapsed_ms: Number.isFinite(elapsedMs) ? elapsedMs : null,
            grace_ms: PM_RESOLVER_TRANSPORT_STALL_GRACE_MS,
            transport_error: transportError
          });
          continue;
        }

        const priorDemotions = countPmResolverTransportStallDemotions(state, entry.issue?.worker_id);
        if (priorDemotions >= PM_RESOLVER_TRANSPORT_STALL_MAX_RETRIES) {
          this.log.info("Watchdog: PM resolver transport-stalled; retry cap reached, preserving entry for human takeover", {
            event: "watchdog_pm_resolver_transport_stall_retry_exhausted",
            dispatchPlanPath,
            pm_thread_id: pmThreadId,
            worker_id: entry.issue?.worker_id ?? null,
            prior_demotions: priorDemotions,
            max_retries: PM_RESOLVER_TRANSPORT_STALL_MAX_RETRIES,
            transport_error: transportError
          });
          continue;
        }

        try {
          lifecycleStore.markPmResolverTransportStallDemotion(pmThreadId, transportError, priorDemotions);
        } catch (error) {
          this.log.warn("Watchdog: failed to demote transport-stalled PM resolver", {
            event: "watchdog_pm_resolver_transport_stall_demote_error",
            dispatchPlanPath,
            pm_thread_id: pmThreadId,
            worker_id: entry.issue?.worker_id ?? null,
            error: asError(error).message
          });
        }
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

      if (isPmResolverNoProgressStale(entry, nowMs)) {
        const reason = `${PM_RESOLVER_NO_PROGRESS_ERROR_PREFIX} hub_status=${observationKind}; last_seen_at=${entry.last_seen_at}; threshold_ms=${PM_RESOLVER_NO_PROGRESS_STALE_MS}`;
        try {
          lifecycleStore.markPmResolverNoProgressDemotion(pmThreadId, reason);
        } catch (error) {
          this.log.warn("Watchdog: failed to demote no-progress PM resolver", {
            event: "watchdog_pm_resolver_no_progress_demote_error",
            dispatchPlanPath,
            pm_thread_id: pmThreadId,
            worker_id: entry.issue?.worker_id ?? null,
            observed_status: observationKind,
            error: asError(error).message
          });
          continue;
        }

        try {
          await this.killThread(pmThreadId);
          this.log.info("Watchdog: stale no-progress PM resolver killed", {
            event: "watchdog_pm_resolver_no_progress_kill",
            dispatchPlanPath,
            pm_thread_id: pmThreadId,
            worker_id: entry.issue?.worker_id ?? null,
            observed_status: observationKind
          });
        } catch (error) {
          const message = asError(error).message;
          if (isMissingThreadEvidence(message)) {
            this.log.info("Watchdog: stale no-progress PM resolver already missing during kill", {
              event: "watchdog_pm_resolver_no_progress_kill_missing",
              dispatchPlanPath,
              pm_thread_id: pmThreadId,
              worker_id: entry.issue?.worker_id ?? null,
              observed_status: observationKind,
              error: message
            });
            continue;
          }
          if (isHubTransportEvidence(message)) {
            this.log.info("Watchdog: stale no-progress PM resolver demoted; kill deferred by hub transport", {
              event: "watchdog_pm_resolver_no_progress_kill_transport_stall",
              dispatchPlanPath,
              pm_thread_id: pmThreadId,
              worker_id: entry.issue?.worker_id ?? null,
              observed_status: observationKind,
              error: message
            });
            continue;
          }
          this.log.warn("Watchdog: stale no-progress PM resolver kill failed", {
            event: "watchdog_pm_resolver_no_progress_kill_error",
            dispatchPlanPath,
            pm_thread_id: pmThreadId,
            worker_id: entry.issue?.worker_id ?? null,
            observed_status: observationKind,
            error: message
          });
        }
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
   * Steady-state reaper for silent-death worker threads. Mirrors
   * `reconcilePmResolverLiveness` but for workers: when a Codex stdin
   * transport bug (or any other silent agentapi death) leaves a worker row at
   * `status=running` with no marker delivered, the dispatcher refuses to
   * advance — `continue` returns `still_blocked: running worker(s)` and the
   * round wedges. Per-tick, for each `running` worker we require ALL three of:
   *
   *   1. `last_seen_at` past `WORKER_HEARTBEAT_STALE_THRESHOLD_MS`
   *   2. `isAgentapiProcessAliveForThread` returns false (no live ps signature
   *      matching `agentapi-<thread_id>.sock`)
   *   3. hub liveness probe returns `missing`/`failed`/`idle`/`completed`
   *      — anything other than `running`
   *
   * before flipping the row to `failed`. The triple-gate makes legitimate
   * long-running workers safe: a healthy worker either advances `last_seen_at`
   * via reconciler hub_result, has a live ps process, or the hub still
   * reports it `running`. The reaped worker then becomes eligible for normal
   * PM-resolver spawn / retry on the next continue tick.
   */
  private async reconcileWorkerHeartbeats(
    lifecycleStore: LifecycleStore,
    dispatchPlanPath: string
  ): Promise<void> {
    let state: DispatchThreadStateV2;
    try {
      state = lifecycleStore.load();
    } catch (error) {
      this.log.warn("Watchdog: failed to read lifecycle state for worker heartbeat sweep", {
        dispatchPlanPath,
        error: asError(error).message
      });
      return;
    }

    const nowMs = this.now();
    for (const [workerId, worker] of Object.entries(state.workers)) {
      if (workerId === DISPATCHER_WORKER_ID) {
        continue;
      }
      if (worker.status !== "running") {
        continue;
      }
      const threadId = worker.thread_id?.trim();
      if (!threadId) {
        continue;
      }
      if (!isWorkerHeartbeatStale(worker, nowMs)) {
        continue;
      }
      if (isAgentapiProcessAliveForThread(threadId)) {
        this.log.info("Watchdog: worker heartbeat stale but agentapi process alive; preserving", {
          event: "watchdog_worker_heartbeat_codex_alive",
          dispatchPlanPath,
          worker_id: workerId,
          thread_id: threadId,
          last_seen_at: worker.last_seen_at
        });
        continue;
      }

      let observationKind: "missing" | "failed" | "running" | "idle" | "completed";
      try {
        const observation = await queryHubThreadObservation(this.hubClient, threadId);
        observationKind = observation.kind;
      } catch (error) {
        this.log.warn("Watchdog: worker heartbeat liveness probe failed", {
          event: "watchdog_worker_heartbeat_probe_error",
          dispatchPlanPath,
          worker_id: workerId,
          thread_id: threadId,
          error: asError(error).message
        });
        continue;
      }

      if (observationKind === "running") {
        // Hub still believes the worker thread is live — that disagrees with
        // our agentapi-process probe, but defer to the hub since killing a
        // worker the hub still routes to would interrupt in-flight work.
        // Reconciler / next sweep will either see the agentapi come back or
        // the hub flip to missing.
        continue;
      }

      const reason = `watchdog_reaped: heartbeat_stale (last_seen_at=${worker.last_seen_at}, threshold_ms=${WORKER_HEARTBEAT_STALE_THRESHOLD_MS}); agentapi_process_missing; hub_status=${observationKind}`;
      try {
        lifecycleStore.markWorkerReaped(workerId, reason);
      } catch (error) {
        this.log.warn("Watchdog: failed to mark worker reaped", {
          event: "watchdog_worker_reaped_save_error",
          dispatchPlanPath,
          worker_id: workerId,
          thread_id: threadId,
          error: asError(error).message
        });
        continue;
      }
      this.log.info("Watchdog: reaped silent worker thread", {
        event: "watchdog_worker_reaped",
        dispatchPlanPath,
        worker_id: workerId,
        thread_id: threadId,
        last_seen_at: worker.last_seen_at,
        hub_status: observationKind,
        threshold_ms: WORKER_HEARTBEAT_STALE_THRESHOLD_MS
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
    const {
      pendingWorkerCount,
      continueWorkerId,
      exhaustedPmResolverWorkerIds,
      awaitingHumanResolution,
      awaitingMaterialization
    } = await resolveRecoverableWorkerState(dispatchPlanPath, state);

    // Parked-awaiting-human heartbeat. Emitted before the stall detector so the
    // operator sees it whether or not this tick goes on to attempt anything.
    this.reportAwaitingHumanResolution(dispatchPlanPath, state, awaitingHumanResolution);

    // Parked-awaiting-materialization heartbeat, for the same reason.
    this.reportAwaitingMaterialization(dispatchPlanPath, state, awaitingMaterialization);

    // Emit one structured log line per (dispatchPlanPath, workerId) tuple
    // whose recovery path is exhausted. Without this, the stalled-dispatcher
    // detector below either re-fires every tick on the same worker (when the
    // skip was not yet applied) or stays silent forever (now that
    // resolveManualInterventionWorker skips exhausted resolvers), and the
    // operator has no signal that a dispatcher needs human action.
    this.reportExhaustedPmResolvers(dispatchPlanPath, state, exhaustedPmResolverWorkerIds);

    if (!this.onDispatcherStalled) {
      return;
    }

    if (pendingWorkerCount === 0 && !continueWorkerId) {
      return;
    }

    // NARROW notion on purpose (status === "running" only). This number decides
    // "is something alive and progressing, so keep stall recovery suppressed",
    // NOT "is there a free slot" — see resolveOccupiedParallelSlots for that
    // one. Widening it here would take the `mode: "idle"` branch below
    // unreachable for exactly the state it was written for: a row parked in
    // `awaiting_validation` with nothing running would read as "running > 0",
    // return early, and never reach the stall-recovery machinery that is the
    // only thing able to unwedge a genuinely dead dispatcher. That is the
    // under-dispatch regression (baseline 0.751/3 mean concurrency, 38.7%
    // zero-worker time) this file already paid for once.
    const blockingRunningWorkers = resolveBlockingRunningWorkers(state, continueWorkerId);
    if (blockingRunningWorkers.length > 0) {
      // A running worker means the round is progressing, so the stall-recovery
      // machinery below (hub probe → relaunch hub session → reactivate the
      // role) must stay suppressed: firing it here is the loop this guard was
      // added to stop. That protection is left intact — the branch below never
      // reaches it.
      //
      // But "a worker is running" is not the same as "there is nothing to
      // start". With parallel_dispatch this guard was the second of the three
      // serial choke points: 1 running worker suppressed continuation for all
      // of max_concurrency, so the plan could only ever advance one row at a
      // time. Rather than relax the guard, take a separate narrow exit that
      // does exactly one thing — ask for a bare parallel continue so the
      // launcher can fill the idle slots — and never falls through to
      // stall recovery (see `parallelSlotFill` on DispatcherStallInfo).
      await this.maybeRequestParallelSlotFill(
        dispatchPlanPath,
        pendingWorkerCount,
        state,
        blockingRunningWorkers,
        "running"
      );
      return;
    }

    // Zero running workers is the LARGER starvation bucket, not a smaller one,
    // and the first cut of this fix missed it entirely by living inside the
    // branch above. `resolveBlockingRunningWorkers` counts only lifecycle
    // status === "running", so a row held in `awaiting_validation` counts as
    // zero — and with zero running the sweep fell straight through to the
    // targeted stall-recovery path, which services exactly ONE row per tick.
    //
    // Observed on the deployed build (2026-08-10 16:52 restart, stable 8+ min):
    // BATCH-7-GATE awaiting_validation, C-02 and C-04a pending with satisfied
    // dependencies, max_concurrency 3, running rows 0 — "Watchdog requesting
    // parallel slot fill" fired 0 times while one targeted continuation ran
    // against BATCH-7-GATE. C-02 and C-04a starved behind a validator. For the
    // measured round that region is concurrency-0 for 9.31h (38.7% of the
    // window) plus 2.46h validator-active.
    //
    // It was also circular: 144729f's validator deferral only engages under
    // `isParallelAutoContinue`, which needs a bare continue, whose only
    // producer was this method — gated on running > 0. A plan sitting in
    // awaiting_validation with nothing running could therefore never bootstrap
    // into parallel mode, so the deferral 144729f was written for was
    // unreachable in exactly the state it was written for.
    //
    // Ask for the slot fill FIRST, then fall through. Unlike the branch above
    // this does NOT return: a dispatcher with zero running workers may be
    // genuinely stalled, and the hub probe / relaunch / role reactivation /
    // PM-resolver machinery below is the only thing that recovers it. The one
    // case worth skipping is when the bare continue actually started something
    // — re-read the lifecycle store and check, rather than trusting the
    // callback's (void) return.
    const requestedSlotFill = await this.maybeRequestParallelSlotFill(
      dispatchPlanPath,
      pendingWorkerCount,
      state,
      blockingRunningWorkers,
      "idle"
    );
    if (requestedSlotFill) {
      const stateAfterSlotFill = lifecycleStore.load();
      // NARROW notion again, and for a third distinct reason: the question here
      // is "did the bare continue actually START anything", and a launch is
      // observable precisely as a row flipping to `running`. Occupancy is the
      // wrong instrument — it was already non-zero before the callback (that is
      // what an `awaiting_validation` row contributes), so an occupancy-based
      // check here would report "workers launched" on every tick where a
      // validator merely kept scoring, and would swallow the fall-through to
      // stall recovery that this branch exists to preserve.
      const launchedWorkers = resolveBlockingRunningWorkers(stateAfterSlotFill, continueWorkerId);
      if (launchedWorkers.length > 0) {
        this.log.info("Watchdog parallel slot fill started workers; skipping stall recovery", {
          dispatchPlanPath,
          launchedWorkers
        });
        return;
      }
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

  /**
   * Fires the stall callback in `parallelSlotFill` mode — bare (no
   * continueWorkerId), so continueDispatcherForRole takes its
   * `isParallelAutoContinue` branch and fills free slots. Returns whether the
   * callback was actually invoked.
   *
   * Two call sites, deliberately:
   *   - `mode: "running"` — companion to the `blockingRunningWorkers` guard.
   *     Worker(s) alive, hub session healthy; the caller returns straight
   *     after, never touching stall recovery.
   *   - `mode: "idle"` — zero running workers. The caller does NOT return: a
   *     dispatcher with nothing running may be genuinely stalled and still
   *     needs the recovery machinery. This is the bucket the first cut missed
   *     — `resolveBlockingRunningWorkers` counts only status === "running", so
   *     a row parked in `awaiting_validation` reads as zero running and the
   *     sweep serviced exactly one row per tick.
   *
   * The `mode` argument therefore rides on the NARROW running count, and that
   * is correct: it is a statement about whether the caller is going to fall
   * through to stall recovery. The capacity gate below is a different question
   * and uses a different number — see `resolveOccupiedParallelSlots`. Reusing
   * the narrow count for capacity is the accounting bug this separation fixes:
   * `awaiting_validation` (validator thread live), `fix_requested` (a slot
   * reserved for a row that flips back to `running` on the next tick) and
   * active PM resolver threads each hold a Hub lane while contributing zero,
   * so a plan with `max_concurrency: 3` and three lanes already taken still
   * read as "slots free" and admitted a fourth agent. Measured on a real
   * round: peak concurrency 4 against `max_concurrency: 3`.
   *
   * Both require all of:
   *   - the operator-facing kill-switch is on (MERIDIAN_DISPATCH_AUTO_PARALLEL);
   *   - the owning dispatcher actually has `parallel_dispatch.enabled`;
   *   - OCCUPIED slots are strictly under `max_concurrency`, so there is a
   *     real slot rather than a rounding argument;
   *   - there is DAG-ready pending work (`pendingWorkerCount > 0`), which
   *     already excludes rows whose dependencies are unmet, human/PM rows, and
   *     rows carrying an automatic-dispatch blocker note.
   *
   * Any of those failing leaves behaviour byte-identical to before this path
   * existed. The continue itself is still breaker-gated on the receiving side,
   * on the same `__parallel__` key and whole-plan sig for both modes.
   */
  private async maybeRequestParallelSlotFill(
    dispatchPlanPath: string,
    pendingWorkerCount: number,
    state: DispatchThreadStateV2,
    blockingRunningWorkers: string[],
    mode: "running" | "idle"
  ): Promise<boolean> {
    if (!this.onDispatcherStalled || !this.resolveParallelDispatchForPlan) {
      return false;
    }
    if (!isDispatchAutoParallelEnabled()) {
      return false;
    }
    if (pendingWorkerCount <= 0) {
      return false;
    }

    let parallelDispatch: WatchdogParallelDispatchInfo | null;
    try {
      parallelDispatch = await this.resolveParallelDispatchForPlan(dispatchPlanPath);
    } catch (error) {
      this.log.warn("Watchdog failed to resolve parallel_dispatch config for slot fill", {
        dispatchPlanPath,
        error: asError(error).message
      });
      return false;
    }

    if (!parallelDispatch?.enabled) {
      return false;
    }
    // TRUE occupancy, not `blockingRunningWorkers.length`. This is the only
    // place in this file that asks "is there a free slot to launch into", and
    // it is the only place that gets the wide count.
    const occupancy = resolveOccupiedParallelSlots(state, this.now());
    if (occupancy.count >= parallelDispatch.maxConcurrency) {
      return false;
    }

    this.log.info("Watchdog requesting parallel slot fill", {
      dispatchPlanPath,
      mode,
      pendingWorkerCount,
      // `runningWorkers` keeps its pre-fix meaning (narrow, status ===
      // "running") so existing log greps and dashboards do not silently change
      // definition; the occupancy fields are additive and are what the gate
      // above actually decided on.
      runningWorkers: blockingRunningWorkers,
      occupiedSlots: occupancy.count,
      occupiedWorkers: occupancy.workerIds,
      occupiedPmResolverThreads: occupancy.pmResolverThreadIds,
      maxConcurrency: parallelDispatch.maxConcurrency,
      availableSlots: parallelDispatch.maxConcurrency - occupancy.count
    });

    try {
      await this.onDispatcherStalled({
        dispatchPlanPath,
        // Distinct values so the two entry points are separable in the log
        // stream — "idle" is the one that had zero coverage on the first cut.
        dispatcherStatus: mode === "running"
          ? "running_parallel_slots_free"
          : "idle_parallel_slots_free",
        pendingWorkerCount,
        continueWorkerId: null,
        parallelSlotFill: true
      });
      return true;
    } catch (error) {
      this.log.warn("Watchdog parallel slot fill callback failed", {
        dispatchPlanPath,
        mode,
        error: asError(error).message
      });
      // Report not-requested so the idle caller falls through to the ordinary
      // stall-recovery path: a callback that threw proves nothing was started.
      return false;
    }
  }

  /**
   * Emit `dispatcher_awaiting_human_resolution` for every row parked behind an
   * unreleased `escalate_human`, at most once per
   * {@link AWAITING_HUMAN_RESOLUTION_HEARTBEAT_MS} per (plan, worker,
   * escalation).
   *
   * This is the operator's "waiting on a human" signal, and it is the one that
   * was missing: `dispatcher_pm_resolver_exhausted` already fired once for
   * BATCH-8-GATE at 21:02:11Z, and the row then read as ordinary `pending` for
   * two hours. A heartbeat (rather than the one-shot dedup used above) is what
   * makes a long park stay visible; `parked_for_ms` makes the cost legible at a
   * glance.
   *
   * What counts as parked is NOT decided here: `parked` comes from
   * `findUnreleasedHumanEscalation`, which already drops rows whose work
   * concluded (`completed`/`skipped`) without a human verdict. Keeping that
   * judgement in the single-sourced predicate is deliberate — a filter applied
   * only to the log would leave the continue-dispatcher responses and
   * `/worker/<id>` surfaces still calling the same row frozen. Do not add an
   * age-based or dedupe-window suppression on top: the throttle above bounds
   * the CADENCE of a genuine park, it must never end one.
   */
  private reportAwaitingHumanResolution(
    dispatchPlanPath: string,
    state: DispatchThreadStateV2,
    parked: readonly HumanEscalationFreeze[]
  ): void {
    const nowMs = this.now();
    const dispatcherThreadId = state.dispatcher.thread_id?.trim() ?? null;
    const activeKeys = new Set<string>();

    for (const freeze of parked) {
      const key = `${dispatchPlanPath}::${freeze.workerId}::${freeze.escalatedAt}`;
      activeKeys.add(key);
      const lastLoggedAtMs = this.loggedAwaitingHumanResolutionAtMs.get(key);
      if (
        lastLoggedAtMs !== undefined
        && nowMs - lastLoggedAtMs < AWAITING_HUMAN_RESOLUTION_HEARTBEAT_MS
      ) {
        continue;
      }
      this.loggedAwaitingHumanResolutionAtMs.set(key, nowMs);

      const escalatedAtMs = Date.parse(freeze.escalatedAt);
      this.log.info("dispatcher_awaiting_human_resolution", {
        event: "dispatcher_awaiting_human_resolution",
        dispatchPlanPath,
        dispatcherThreadId,
        workerId: freeze.workerId,
        pmResolverThreadId: freeze.pmResolverThreadId,
        escalatedAt: freeze.escalatedAt,
        lastHumanResolvedAt: freeze.humanResolvedAt,
        ...(Number.isNaN(escalatedAtMs) ? {} : { parkedForMs: Math.max(0, nowMs - escalatedAtMs) }),
        hint: "row is parked awaiting a human, NOT queued; POST /worker/<id>/human-resolve to release it"
      });
    }

    const planPrefix = `${dispatchPlanPath}::`;
    for (const key of this.loggedAwaitingHumanResolutionAtMs.keys()) {
      if (key.startsWith(planPrefix) && !activeKeys.has(key)) {
        this.loggedAwaitingHumanResolutionAtMs.delete(key);
      }
    }
  }

  /**
   * Emit `dispatcher_awaiting_materialization` for every row parked behind a
   * capsule that still carries `⏳ 待物化`, at most once per
   * {@link AWAITING_MATERIALIZATION_HEARTBEAT_MS} per (plan, worker, reason).
   *
   * `reason` is the field an operator actually needs: `awaiting_dependencies`
   * means the orchestrator will fill it by itself the moment the named rows
   * complete — do nothing; `awaiting_pm` means the remainder is not derivable
   * and the round will sit there until PM writes those sections;
   * `spec_not_written` means the row's card/capsule were declared in `plan.json`
   * and never authored (the I-08/I-09 shape — the watchdog is the component that
   * picked I-09 up and launched it against files that did not exist, so it is
   * the component that most needs to say so); `spec_manifest_unreadable` means
   * `plan.json` itself cannot be read and every row is failing closed.
   */
  private reportAwaitingMaterialization(
    dispatchPlanPath: string,
    state: DispatchThreadStateV2,
    parked: readonly CapsuleMaterializationHold[]
  ): void {
    const nowMs = this.now();
    const dispatcherThreadId = state.dispatcher.thread_id?.trim() ?? null;
    const activeKeys = new Set<string>();

    for (const hold of parked) {
      const key = `${dispatchPlanPath}::${hold.workerId}::${hold.reason}`;
      activeKeys.add(key);
      const lastLoggedAtMs = this.loggedAwaitingMaterializationAtMs.get(key);
      if (
        lastLoggedAtMs !== undefined
        && nowMs - lastLoggedAtMs < AWAITING_MATERIALIZATION_HEARTBEAT_MS
      ) {
        continue;
      }
      this.loggedAwaitingMaterializationAtMs.set(key, nowMs);

      this.log.info("dispatcher_awaiting_materialization", {
        event: "dispatcher_awaiting_materialization",
        dispatchPlanPath,
        dispatcherThreadId,
        workerId: hold.workerId,
        capsulePath: hold.capsulePath,
        reason: hold.reason,
        sections: hold.placeholders.map((placeholder) => placeholder.section ?? `line ${placeholder.line}`),
        pendingDependencies: hold.pendingDependencies,
        underivableReasons: hold.underivableReasons,
        specManifestPath: hold.specManifestPath,
        specManifestError: hold.specManifestError,
        missingSpecFiles: hold.missingSpecFiles.map((file) => ({
          kind: file.kind,
          declaredPath: file.declaredPath,
          resolvedPath: file.resolvedPath,
          state: file.state
        })),
        hint: resolveAwaitingMaterializationHint(hold)
      });
    }

    const planPrefix = `${dispatchPlanPath}::`;
    for (const key of this.loggedAwaitingMaterializationAtMs.keys()) {
      if (key.startsWith(planPrefix) && !activeKeys.has(key)) {
        this.loggedAwaitingMaterializationAtMs.delete(key);
      }
    }
  }

  private reportExhaustedPmResolvers(
    dispatchPlanPath: string,
    state: DispatchThreadStateV2,
    exhaustedWorkerIds: string[]
  ): void {
    const activeKeys = new Set<string>();
    const dispatcherThreadId = state.dispatcher.thread_id?.trim() ?? null;
    for (const workerId of exhaustedWorkerIds) {
      const key = `${dispatchPlanPath}::${workerId}`;
      activeKeys.add(key);
      if (this.loggedExhaustedPmResolverKeys.has(key)) {
        continue;
      }
      this.loggedExhaustedPmResolverKeys.add(key);
      this.log.info("dispatcher_pm_resolver_exhausted", {
        event: "dispatcher_pm_resolver_exhausted",
        dispatchPlanPath,
        dispatcherThreadId,
        workerId,
        issueStatus: "manual_intervention_required",
        hint: "PM resolver terminal without resolve; operator action required"
      });
    }
    // Forget keys whose worker is no longer flagged as exhausted under this
    // plan path — covers PM-resolver re-spawn after operator action, worker
    // transition, or dispatcher pause/resume. Other dispatch_plan_paths
    // are untouched so a sweep that skipped a plan (read error, missing
    // markdown) does not silently re-arm its already-logged keys.
    const planPrefix = `${dispatchPlanPath}::`;
    for (const key of this.loggedExhaustedPmResolverKeys) {
      if (key.startsWith(planPrefix) && !activeKeys.has(key)) {
        this.loggedExhaustedPmResolverKeys.delete(key);
      }
    }
  }
}

function countWorkersInStatus(state: DispatchThreadStateV2, status: string): number {
  return Object.values(state.workers).filter((worker) => worker.status === status).length;
}

/**
 * The NARROW notion: worker rows that are literally `running` right now.
 *
 * Answers "is a worker alive and progressing" — i.e. should stall recovery
 * stay suppressed, and did a bare continue actually launch something. It is
 * NOT a capacity number and must never be compared against
 * `parallel_dispatch.max_concurrency`; use `resolveOccupiedParallelSlots`
 * (slot-occupancy.ts) for that. The two were the same value once, and both
 * production failure modes — over-dispatch to 4 against max 3, and the
 * under-dispatch that the `mode: "idle"` slot-fill path exists to cure — trace
 * back to that single number being asked two incompatible questions.
 *
 * The `continueWorkerId` clause is part of the narrow semantics, not an
 * oversight: the row the caller is about to (re)launch does not count as
 * blocking itself while its thread is cleared. Capacity accounting has no such
 * exemption, which is one more reason the two live apart.
 */
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

/**
 * The one-line operator instruction per hold reason. Split out so every reason
 * reads as its own case rather than as a nested ternary whose final `else`
 * silently absorbs any reason added later — which is exactly how
 * `spec_not_written` would have been reported as "PM must write the capsule
 * sections" for a capsule that does not exist.
 */
function resolveAwaitingMaterializationHint(hold: CapsuleMaterializationHold): string {
  switch (hold.reason) {
    case "awaiting_dependencies":
      return "row is parked until its named dependencies reach completed; the dispatcher fills the capsule automatically at that point — no operator action";
    case "awaiting_fill":
      return "every named dependency is completed; the next continue tick fills the capsule — no operator action";
    case "awaiting_pm":
      return "row is parked because the remaining capsule sections are NOT derivable by the dispatcher; PM must write them into the capsule";
    case "spec_not_written":
      return `row is parked because plan.json declares spec files that do not exist on disk (${hold.missingSpecFiles
        .map((file) => `${file.kind}: ${file.declaredPath} [${file.state}]`)
        .join(", ")}); the row was registered before its spec was authored — write the file(s), no retry will help`;
    case "spec_manifest_unreadable":
      return `row is parked because ${hold.specManifestPath} could not be read as a task graph (${hold.specManifestError ?? "unknown error"}); every launch fails closed until the manifest is repaired or removed`;
    default:
      return "row is parked behind the dispatch materialization precondition";
  }
}

async function resolveRecoverableWorkerState(
  dispatchPlanPath: string,
  state: DispatchThreadStateV2
): Promise<{
  pendingWorkerCount: number;
  continueWorkerId: string | null;
  exhaustedPmResolverWorkerIds: string[];
  awaitingHumanResolution: HumanEscalationFreeze[];
  awaitingMaterialization: CapsuleMaterializationHold[];
}> {
  try {
    const markdown = await fs.readFile(dispatchPlanPath, "utf8");
    const rows = parseDispatchPlanRows(markdown);
    // The materialization precondition, READ-ONLY here. The watchdog must not
    // perform the fill: the fill is the continue tick's job, and duplicating it
    // on a second clock would create two writers of the same capsule. The
    // watchdog's job is only to stop selecting a row that cannot launch, and to
    // make the park visible.
    const capsuleGate = createCapsuleMaterializationGate(dispatchPlanPath, state);
    // All three resolvers already refuse rows under an unreleased
    // `escalate_human`: the first two via `isEligibleServiceContinueRow` /
    // `resolveManualInterventionWorker` in service-continuation.ts, the middle
    // one via its own check. So a parked row can never become `continueWorkerId`
    // and therefore never reaches `tryContinueDispatchWorker`. The first and
    // middle now refuse an unmaterialized capsule on the same terms.
    const continueWorkerId = resolveServiceContinueWorkerFromWorkerRows(rows, state, { capsuleGate })
      ?? resolveValidationContinueWorkerFromWorkerRows(rows, state, capsuleGate)
      ?? resolveManualInterventionWorkerFromWorkerRows(rows, state);
    return {
      pendingWorkerCount: countEligiblePendingServiceContinueWorkersFromWorkerRows(rows, state, { capsuleGate }),
      continueWorkerId,
      exhaustedPmResolverWorkerIds: resolveExhaustedPmResolverWorkersFromWorkerRows(rows, state),
      awaitingHumanResolution: resolveHumanEscalationParkedWorkersFromWorkerRows(rows, state),
      awaitingMaterialization: resolveCapsuleMaterializationParkedWorkers(
        rows.map((row) => ({ worker: row.worker_id, branch: row.branch ?? null })),
        capsuleGate
      )
    };
  } catch {
    return {
      pendingWorkerCount: countWorkersInStatus(state, "pending"),
      continueWorkerId: null,
      exhaustedPmResolverWorkerIds: [],
      awaitingHumanResolution: [],
      awaitingMaterialization: []
    };
  }
}

function resolveValidationContinueWorkerFromWorkerRows(
  rows: ReturnType<typeof parseDispatchPlanRows>,
  state: DispatchThreadStateV2,
  capsuleGate?: CapsuleMaterializationGate
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

    // Escalation freeze. This resolver is the third door into a targeted
    // continue (after `resolveServiceContinueWorkerFromWorkerRows` and
    // `resolveManualInterventionWorkerFromWorkerRows`) and it reads the
    // lifecycle store directly rather than going through
    // `isEligibleServiceContinueRow`, so it needs its own check. It is also
    // the door that mattered on BATCH-8-GATE: the parked row cycled through
    // fix_requested four times, and each cycle came back through here.
    if (isFrozenPendingHumanResolution(state, workerId)) {
      continue;
    }

    // Materialization precondition — same third-door reasoning. A fix_requested
    // row whose capsule is still `⏳` would otherwise be handed straight back to
    // a worker that cannot satisfy it.
    if (capsuleGate?.(workerId)) {
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
