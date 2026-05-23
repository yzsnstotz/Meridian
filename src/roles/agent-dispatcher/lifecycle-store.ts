import * as fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { Logger } from "../base-role";
import { FALLBACK_HEURISTICS_ENABLED } from "../../config";
import {
  DispatchThreadStateV2Schema,
  type DispatchThreadStateV2,
  type DispatchWorkerState,
  type HubResult,
  type LifecycleStatus,
  type LifecycleWorkerEntry,
  type PmResolverIssueState,
  type PmResolverLifecycleState,
  type PmResolverLifecycleStatus,
  type PmResolverResultState
} from "../../types";
import {
  outputArtifactHasPassingDecision,
  outputArtifactHasPassingOutcome,
  outputArtifactHasPassingWorkerMarker,
  outputArtifactsContain,
  outputsExist as outputArtifactsExist,
  sliceContentFromStartedAt
} from "./output-artifacts";
import { parseMeridianStatusMarker } from "./meridian-status-marker";

const EPOCH_ISO = new Date(0).toISOString();
const DISPATCH_PLAN_FILENAME = "dispatch_plan.md";
const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";
export const PM_RESOLVER_LIVENESS_GRACE_MS = 90 * 1000;

// Validator spawn/run failure backoff. After this many consecutive failures
// (validator spawn errors, run errors, parse errors — anything that ends in
// clearValidatorStart), the worker enters backoff: watchdog and the validation
// queue both refuse to re-spawn until the backoff window elapses. Prevents
// tight retry loops from exhausting Hub/system file descriptors when the
// underlying spawn transport is broken (e.g. codex cwd not in trusted projects).
export const VALIDATOR_SPAWN_FAILURE_BACKOFF_THRESHOLD = 3;
export const VALIDATOR_SPAWN_FAILURE_BACKOFF_MS = 10 * 60 * 1000;

export function isValidatorSpawnBackoffActive(
  validation: { spawn_failure_count?: number | null; last_spawn_failure_at?: string | null } | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!validation) {
    return false;
  }
  const count = validation.spawn_failure_count ?? 0;
  if (count < VALIDATOR_SPAWN_FAILURE_BACKOFF_THRESHOLD) {
    return false;
  }
  const lastFailureAt = validation.last_spawn_failure_at;
  if (!lastFailureAt) {
    return false;
  }
  const lastFailureMs = Date.parse(lastFailureAt);
  if (Number.isNaN(lastFailureMs)) {
    return false;
  }
  return nowMs - lastFailureMs < VALIDATOR_SPAWN_FAILURE_BACKOFF_MS;
}

export function isPmResolverLivenessGraceActive(
  entry: Pick<PmResolverLifecycleState, "started_at" | "last_seen_at" | "result">,
  nowMs: number = Date.now()
): boolean {
  if (entry.result) {
    return false;
  }

  const startedAtMs = Date.parse(entry.started_at);
  if (Number.isNaN(startedAtMs)) {
    return false;
  }

  const lastSeenAtMs = entry.last_seen_at ? Date.parse(entry.last_seen_at) : NaN;
  const observedAtMs = Number.isNaN(lastSeenAtMs)
    ? startedAtMs
    : Math.max(startedAtMs, lastSeenAtMs);

  return nowMs - observedAtMs < PM_RESOLVER_LIVENESS_GRACE_MS;
}

const LegacyWorkerThreadEntrySchema = z.object({
  thread_id: z.string().min(1),
  started_at: z.string().datetime().optional()
});

const LegacyDispatchThreadFileSchema = z.object({
  dispatcher_thread_id: z.string().min(1).nullable().optional(),
  workers: z
    .record(z.string(), z.union([z.string().min(1), LegacyWorkerThreadEntrySchema]))
    .default({})
});

const PLAN_STATUS_SYMBOLS: Record<LifecycleStatus, string> = {
  pending: "⬜",
  running: "🔄",
  completed: "✅",
  failed: "❌",
  blocked: "⛔ BLOCKED",
  abandoned: "⚠️ ABANDONED",
  skipped: "⛔ SKIPPED",
  awaiting_validation: "🔍",
  fix_requested: "🔁"
};

export interface LifecycleStoreOptions {
  beforeCommit?: (tempFilePath: string, targetFilePath: string) => void;
  dispatchPlanPath?: string;
  log?: Pick<Logger, "info" | "warn">;
  now?: () => string;
  /**
   * Phase A6 kill-switch override. Production code reads
   * {@link FALLBACK_HEURISTICS_ENABLED} from `src/config.ts`; this option
   * exists so tests can toggle the gate without mutating `process.env`.
   */
  fallbackHeuristicsEnabled?: boolean;
}

export class LifecycleStore {
  readonly filePath: string;

  private readonly beforeCommit?: (tempFilePath: string, targetFilePath: string) => void;
  private readonly dispatchPlanPath: string;
  private readonly log: Pick<Logger, "info" | "warn">;
  private readonly now: () => string;
  private readonly fallbackHeuristicsEnabled: boolean;

  constructor(filePath: string, options: LifecycleStoreOptions = {}) {
    this.filePath = filePath;
    this.beforeCommit = options.beforeCommit;
    this.dispatchPlanPath = options.dispatchPlanPath ?? inferDispatchPlanPath(filePath);
    this.log = options.log ?? console;
    this.now = options.now ?? (() => new Date().toISOString());
    this.fallbackHeuristicsEnabled = options.fallbackHeuristicsEnabled ?? FALLBACK_HEURISTICS_ENABLED;
  }

  load(): DispatchThreadStateV2 {
    let raw: string;

    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return buildEmptyDispatchThreadStateV2();
      }

      throw error;
    }

    if (raw.trim().length === 0) {
      const emptyState = buildEmptyDispatchThreadStateV2();
      this.save(emptyState);
      return emptyState;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (isDispatchThreadStateV2(parsed)) {
      return DispatchThreadStateV2Schema.parse(parsed);
    }

    const migrated = migrateLegacyState(parsed);
    this.save(migrated);
    return migrated;
  }

  save(state: DispatchThreadStateV2): void {
    const normalized = DispatchThreadStateV2Schema.parse(state);
    writeFileAtomically(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, this.beforeCommit);
    this.syncPlanView(normalized);
  }

  private mutate(mutator: (state: DispatchThreadStateV2) => void): void {
    const state = this.load();
    mutator(state);
    this.save(state);
  }

  recordDispatcher(threadId: string): void {
    const state = this.load();
    const previousStatus = state.dispatcher.status;
    state.dispatcher = {
      thread_id: threadId,
      started_at: this.now(),
      status: "running"
    };
    this.logTransition("dispatcher", previousStatus, "running", "record_dispatcher");
    this.save(state);
  }

  /**
   * Synchronously bind a worker to a freshly-spawned thread_id WITHOUT
   * the full preamble / expected_outputs / trace_id. Called by the
   * dispatcher's launch path the moment `meridianApi.spawn` returns, so
   * the lifecycle store reflects the assignment before the fire-and-
   * forget run handoff completes its async prep work.
   *
   * Exists to close the race between `launchDispatchWorker` returning
   * (which makes `continue-dispatcher` reply `continued: <workerId>`)
   * and `runTool.execute` calling `recordWorkerStart` (which actually
   * writes the row). Without this placeholder, the dispatcher's next
   * tick or the AI's re-read of `dispatch_threads.json` could see "no
   * entry for this worker" and spawn another thread, stacking parallel
   * agents on the same task.
   *
   * `recordWorkerStart` (called shortly after by runTool.execute) will
   * overwrite the row with the full attempt context. Callers must NOT
   * use this method as a substitute for `recordWorkerStart` on a real
   * launch — it intentionally leaves command_preamble/trace_id/expected
   * _outputs at conservative defaults so reconciler and downstream
   * consumers can still tell "we just spawned, full record pending".
   */
  recordWorkerLaunchInitiated(workerId: string, threadId: string): void {
    const trimmedThreadId = threadId.trim();
    if (!trimmedThreadId) {
      return;
    }
    this.mutate((state) => {
      const nowIso = this.now();
      const previous = state.workers[workerId];
      const previousStatus = previous?.status ?? "pending";
      // Skip rewriting if we'd be overwriting a richer record from
      // runTool.execute that already landed (race in the other direction).
      if (
        previous
        && previous.status === "running"
        && previous.thread_id === trimmedThreadId
        && previous.command_preamble
      ) {
        return;
      }

      // Mirror recordWorkerStart's retry-count discipline: bumping the
      // counter here means recordWorkerStart (which sees previousStatus
      // === "running" after we land) won't double-count. If we skipped
      // the bump, a relaunch from failed/abandoned/blocked would lose
      // its retry charge against MAX_WORKER_RETRIES.
      const previousRetryCount = previous?.retry_count ?? 0;
      const shouldIncrementRetry = previousStatus === "failed"
        || previousStatus === "blocked"
        || previousStatus === "abandoned";

      // Preserve any prior validation context so a relaunch from
      // fix_requested -> running keeps history (mirrors recordWorkerStart).
      const priorValidation = previous?.validation;

      state.workers[workerId] = {
        thread_id: trimmedThreadId,
        trace_id: previous?.trace_id ?? null,
        started_at: nowIso,
        last_seen_at: nowIso,
        status: "running",
        expected_outputs: previous?.expected_outputs ?? [],
        hub_result: null,
        applied_model_id: previous?.applied_model_id,
        applied_reasoning_effort: previous?.applied_reasoning_effort,
        command_preamble: previous?.command_preamble ?? null,
        retry_count: shouldIncrementRetry ? previousRetryCount + 1 : previousRetryCount,
        ...(priorValidation
          ? { validation: { ...priorValidation, validator_thread_id: null } }
          : {})
      };

      this.logTransition(workerId, previousStatus, "running", "launch_initiated");
    });
  }

  recordWorkerStart(
    workerId: string,
    threadId: string,
    traceId: string,
    expectedOutputs: string[],
    commandPreamble?: string | null,
    options: {
      validationMaxFixCycles?: number;
      appliedModelId?: string;
      appliedReasoningEffort?: string;
    } = {}
  ): void {
    const state = this.load();
    const nowIso = this.now();
    const previousStatus = state.workers[workerId]?.status ?? "pending";
    const previousRetryCount = state.workers[workerId]?.retry_count ?? 0;

    // When restarting from a terminal state (failed/abandoned), auto-increment
    // retry_count so that the max-retry cap is enforced even when the restart
    // is triggered by the AI dispatcher rather than the service-continuation
    // path (which increments via setWorkerStatus). Restarts from "pending"
    // have already been incremented by setWorkerStatus, so skip those.
    const shouldIncrementRetry = previousStatus === "failed" || previousStatus === "blocked" || previousStatus === "abandoned";

    // Preserve any prior validation context across worker relaunches. The
    // earlier gate keyed on `previousStatus === "fix_requested"` only, so a
    // worker that bounced through abandoned/failed/blocked between cycles
    // (e.g. validator feedback delivery to a dead thread → relaunch →
    // abandoned → resume_worker:retry) silently lost its score+feedback and
    // every prior cycle's history. Observed on V-03-A 2026-05-07: cycle-1
    // 0.5 feedback was wiped after a `pending → running (run_tool_start)`
    // transition, leaving the operator without any record of why the worker
    // had been respawning. As long as the lifecycle store has prior
    // validation context for this worker, carry it forward — only reset on
    // truly fresh starts (no prior worker entry, or no prior validation).
    const priorWorker = state.workers[workerId];
    const priorValidation = priorWorker?.validation;
    const hasPriorValidationContext = !!priorValidation && (
      (priorValidation.history?.length ?? 0) > 0
      || typeof priorValidation.last_score === "number"
      || typeof priorValidation.last_feedback === "string"
      || priorValidation.current_cycle > 0
    );

    state.workers[workerId] = {
      thread_id: threadId,
      trace_id: traceId,
      started_at: nowIso,
      last_seen_at: nowIso,
      status: "running",
      expected_outputs: [...expectedOutputs],
      hub_result: null,
      applied_model_id: options.appliedModelId ?? priorWorker?.applied_model_id,
      applied_reasoning_effort: options.appliedReasoningEffort
        ?? priorWorker?.applied_reasoning_effort,
      command_preamble: commandPreamble ?? null,
      retry_count: shouldIncrementRetry ? previousRetryCount + 1 : previousRetryCount,
      ...(options.validationMaxFixCycles !== undefined
        ? {
            validation: {
              current_cycle: hasPriorValidationContext
                ? priorValidation?.current_cycle ?? 0
                : 0,
              max_fix_cycles: options.validationMaxFixCycles,
              // validator_thread_id is always reset on a fresh worker launch:
              // any pending validator was for the old worker thread and
              // would not match the new spawn.
              validator_thread_id: null,
              last_score: hasPriorValidationContext
                ? priorValidation?.last_score ?? null
                : null,
              last_feedback: hasPriorValidationContext
                ? priorValidation?.last_feedback ?? null
                : null,
              history: hasPriorValidationContext
                ? priorValidation?.history ?? []
                : [],
              spawn_failure_count: 0,
              last_spawn_failure_at: null
            }
          }
        : {})
    };

    this.logTransition(workerId, previousStatus, "running", "run_tool_start");
    this.save(state);
  }

  recordWorkerResult(workerId: string, hubResult: HubResult): void {
    const state = this.load();
    const worker = state.workers[workerId];
    if (!worker) {
      throw new Error(`Worker not found in lifecycle state: ${workerId}`);
    }

    const { status: mappedStatus, signalSource } = mapHubResultToLifecycleStatus(
      workerId,
      hubResult,
      worker.expected_outputs,
      worker.started_at,
      this.log,
      this.fallbackHeuristicsEnabled
    );
    const nextStatus = mappedStatus === "completed"
      && worker.validation
      && shouldRouteCompletedToAwaitingValidation(worker)
      ? "awaiting_validation"
      : mappedStatus;
    state.workers[workerId] = {
      ...worker,
      thread_id: hubResult.thread_id || worker.thread_id,
      trace_id: hubResult.trace_id || worker.trace_id,
      last_seen_at: hubResult.timestamp,
      status: nextStatus,
      hub_result: hubResult
    };

    this.logTransition(workerId, worker.status, nextStatus, "hub_result");
    // Phase A6 observability: emit a per-decision lifecycle signal-source log
    // AFTER the transition so the transition event ordering is preserved for
    // downstream consumers, while the kill-switch can be observed by greps
    // on event=lifecycle_signal_source.
    this.log.info("Lifecycle signal source", {
      event: "lifecycle_signal_source",
      worker_id: workerId,
      signal_source: signalSource,
      result: mappedStatus
    });
    this.save(state);
  }

  markAbandoned(workerId: string, reason: string): void {
    const state = this.load();
    const worker = state.workers[workerId];
    if (!worker) {
      throw new Error(`Worker not found in lifecycle state: ${workerId}`);
    }

    state.workers[workerId] = {
      ...worker,
      status: "abandoned",
      last_seen_at: this.now()
    };

    this.logTransition(workerId, worker.status, "abandoned", reason);
    this.save(state);
  }

  setWorkerStatus(
    workerId: string,
    status: LifecycleStatus,
    trigger: string,
    options: {
      clearHubResult?: boolean;
      incrementRetryCount?: boolean;
      resetRetryCount?: boolean;
      appliedModelId?: string;
      appliedReasoningEffort?: string;
    } = {}
  ): void {
    const state = this.load();
    const worker = state.workers[workerId];
    if (!worker) {
      throw new Error(`Worker not found in lifecycle state: ${workerId}`);
    }

    const baseRetryCount = options.resetRetryCount ? 0 : (worker.retry_count ?? 0);
    const shouldIncrementRetryCount = options.incrementRetryCount === true && status === "pending";
    state.workers[workerId] = {
      ...worker,
      last_seen_at: this.now(),
      status,
      hub_result: options.clearHubResult ? null : worker.hub_result,
      ...(options.appliedModelId !== undefined ? { applied_model_id: options.appliedModelId } : {}),
      ...(options.appliedReasoningEffort !== undefined
        ? { applied_reasoning_effort: options.appliedReasoningEffort }
        : {}),
      retry_count: shouldIncrementRetryCount ? baseRetryCount + 1 : baseRetryCount
    };

    this.logTransition(workerId, worker.status, status, trigger);
    reconcilePmResolversForRecoveredWorker(state, workerId, this.log, this.now);
    this.save(state);
  }

  // Operator-driven recovery for the PM-killed-after-human-takeover scenario:
  // worker is blocked, PM escalated to a human and was killed, and the human
  // ended up unblocking the worker thread directly. Without this, the worker
  // sidecar stays `blocked`, the PM entry stays `failed`, and the dispatcher
  // never advances. We mark the worker `running` (puts it back under normal
  // observation/validation) and stamp `human_resolution` so the GUI can show
  // a HUMAN-resolved badge and downstream gates can ignore the prior PM
  // failure. Transitioning to `running` also triggers
  // `reconcilePmResolversForRecoveredWorker`, which promotes any matching
  // `failed`/`running` PM entries to `completed`.
  markHumanResolved(workerId: string, note: string | null): void {
    const state = this.load();
    const worker = state.workers[workerId];
    if (!worker) {
      throw new Error(`Worker not found in lifecycle state: ${workerId}`);
    }
    const nowIso = this.now();
    const previousStatus = worker.status;
    const nextStatus: LifecycleStatus = "running";
    state.workers[workerId] = {
      ...worker,
      last_seen_at: nowIso,
      status: nextStatus,
      human_resolution: {
        resolved_at: nowIso,
        note: note?.trim() ? note.trim() : null
      }
    };
    this.logTransition(workerId, previousStatus, nextStatus, "human_resolved");
    this.log.info("Worker marked HUMAN-resolved", {
      event: "worker_human_resolved",
      worker_id: workerId,
      from_status: previousStatus,
      note: note?.trim() ? note.trim() : null
    });
    reconcilePmResolversForRecoveredWorker(state, workerId, this.log, this.now);
    this.save(state);
  }

  getWorkersInState(status: LifecycleStatus): LifecycleWorkerEntry[] {
    const state = this.load();

    return Object.entries(state.workers)
      .filter(([, worker]) => worker.status === status)
      .map(([workerId, worker]) => ({
        worker_id: workerId,
        ...cloneWorker(worker)
      }));
  }

  toPlanMarkdown(planTemplate: string): string {
    return renderPlanMarkdown(this.load(), planTemplate);
  }

  private syncPlanView(state: DispatchThreadStateV2): void {
    let planTemplate: string;

    try {
      planTemplate = fs.readFileSync(this.dispatchPlanPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }

      throw error;
    }

    const nextPlan = renderPlanMarkdown(state, planTemplate);
    if (nextPlan === planTemplate) {
      return;
    }

    writeFileAtomically(this.dispatchPlanPath, nextPlan);
  }

  logTransition(workerId: string, fromStatus: LifecycleStatus, toStatus: LifecycleStatus, trigger: string): void {
    if (fromStatus === toStatus) {
      return;
    }

    this.log.info("Lifecycle transition", {
      event: "worker_transition",
      worker_id: workerId,
      from_status: fromStatus,
      to_status: toStatus,
      trigger
    });
  }

  // ─── Validation lifecycle transitions ──────────────────────────────────────

  transitionToAwaitingValidation(
    workerId: string,
    maxFixCycles: number,
    options: { clearHubResult?: boolean; trigger?: string } = {}
  ): void {
    this.mutate((state) => {
      const worker = state.workers[workerId];
      if (!worker) return;

      // Idempotency: if a validator is already in flight for this worker,
      // do not reset its state. Without this guard, a duplicate intercept
      // call (e.g. when a late hub_result silently flips the worker back to
      // "completed" while the validator is still running) would clear
      // validator_thread_id and Phase 2 would spawn a second validator on
      // the same cycle. Observed in BATCH-3-GATE on dispatcher a9a66025.
      if (worker.status === "awaiting_validation" && worker.validation?.validator_thread_id?.trim()) {
        return;
      }

      const prevStatus = worker.status;
      worker.status = "awaiting_validation";
      if (options.clearHubResult) {
        worker.hub_result = null;
      }
      worker.validation = {
        current_cycle: worker.validation?.current_cycle ?? 0,
        max_fix_cycles: maxFixCycles,
        // Preserve any existing validator_thread_id. The previous behavior
        // unconditionally reset to null, which combined with a duplicate
        // intercept allowed double validator spawns. The idempotency guard
        // above already handles the active-flight case; this preserve covers
        // the rare case where status is not awaiting_validation but a thread
        // id is still recorded (e.g. crash recovery).
        validator_thread_id: worker.validation?.validator_thread_id ?? null,
        last_score: worker.validation?.last_score ?? null,
        last_feedback: worker.validation?.last_feedback ?? null,
        history: worker.validation?.history ?? [],
        spawn_failure_count: worker.validation?.spawn_failure_count ?? 0,
        last_spawn_failure_at: worker.validation?.last_spawn_failure_at ?? null
      };
      this.logTransition(workerId, prevStatus, "awaiting_validation", options.trigger ?? "validation_intercept");
    });
  }

  recordValidatorStart(workerId: string, validatorThreadId: string): void {
    this.mutate((state) => {
      const worker = state.workers[workerId];
      if (!worker?.validation) return;

      worker.validation.validator_thread_id = validatorThreadId;
    });
  }

  // Called when validator spawn itself fails (before recordValidatorStart could
  // set validator_thread_id). Increments the spawn-failure backoff counter so
  // the watchdog and queue stop hammering a broken spawn transport.
  recordValidatorSpawnFailure(workerId: string): void {
    this.mutate((state) => {
      const worker = state.workers[workerId];
      if (!worker?.validation) return;
      worker.validation.spawn_failure_count = (worker.validation.spawn_failure_count ?? 0) + 1;
      worker.validation.last_spawn_failure_at = this.now();
    });
  }

  clearValidatorStart(workerId: string, validatorThreadId: string): void {
    this.mutate((state) => {
      const worker = state.workers[workerId];
      if (!worker?.validation || worker.validation.validator_thread_id !== validatorThreadId) return;

      worker.validation.validator_thread_id = null;
      // clearValidatorStart is only called on validator spawn/run/parse
      // failures (success paths reset state via recordValidationOutcome).
      // Track consecutive failures so the watchdog and queue can apply a
      // backoff and stop hammering codex when the underlying transport is
      // wedged (observed: cwd not in codex trusted projects → infinite
      // spawn-and-fail loop, eventually exhausting system file descriptors).
      worker.validation.spawn_failure_count = (worker.validation.spawn_failure_count ?? 0) + 1;
      worker.validation.last_spawn_failure_at = this.now();
    });
  }

  // Like clearValidatorStart, but does NOT bump the spawn-failure backoff
  // counter. Used when the validator run rejected with a transport-class error
  // (e.g. "hub may be overloaded", "Headers Timeout", "fetch failed",
  // "ECONNREFUSED") — the validator was successfully spawned and the failure
  // is on the talk-side, not the spawn-side. Counting this toward backoff
  // wedges the worker in a 10-minute timeout the moment hub load is elevated
  // (observed on dispatcher agent-dispatcher-257976f8, worker N-01:
  // 4 consecutive run timeouts → permanent validation_in_progress stall).
  // Mirrors the PM-resolver transport-stall pattern from PR #185.
  clearValidatorStartTransportStall(workerId: string, validatorThreadId: string): void {
    this.mutate((state) => {
      const worker = state.workers[workerId];
      if (!worker?.validation || worker.validation.validator_thread_id !== validatorThreadId) return;

      worker.validation.validator_thread_id = null;
    });
  }

  // Test/debug hook: reset the validator backoff counters so the next tick
  // re-attempts immediately. Not currently called by production code, but
  // exposed for explicit recovery flows.
  resetValidatorSpawnBackoff(workerId: string): void {
    this.mutate((state) => {
      const worker = state.workers[workerId];
      if (!worker?.validation) return;
      worker.validation.spawn_failure_count = 0;
      worker.validation.last_spawn_failure_at = null;
    });
  }

  // Clears the recorded worker thread id while keeping `validation` intact, so
  // continueWorker's fix_requested branch falls through to launching a fresh
  // thread. Used when feedback delivery to the retained worker thread fails
  // (typically because the thread expired) — we relaunch the row instead of
  // escalating to PM.
  clearWorkerThreadForRelaunch(workerId: string, trigger: string): void {
    this.mutate((state) => {
      const worker = state.workers[workerId];
      if (!worker) return;
      worker.thread_id = "";
      worker.last_seen_at = this.now();
      this.logTransition(workerId, worker.status, worker.status, trigger);
    });
  }

  transitionToFixRequested(
    workerId: string,
    score: number,
    feedback: string,
    validatorThreadId: string
  ): void {
    this.mutate((state) => {
      const worker = state.workers[workerId];
      if (!worker || !worker.validation) return;

      const prevStatus = worker.status;
      worker.status = "fix_requested";
      recordValidationOutcome(workerId, worker, score, feedback, validatorThreadId, this.now);
      this.logTransition(workerId, prevStatus, "fix_requested", "validation_below_threshold");
    });
  }

  transitionToValidated(workerId: string, validationResult?: ValidationTransitionResult): void {
    this.mutate((state) => {
      const worker = state.workers[workerId];
      if (!worker) return;

      const prevStatus = worker.status;
      worker.status = "completed";
      if (worker.validation) {
        if (validationResult) {
          recordValidationOutcome(
            workerId,
            worker,
            validationResult.score,
            validationResult.feedback,
            validationResult.validatorThreadId,
            this.now
          );
        } else {
          worker.validation.validator_thread_id = null;
        }
      }
      this.logTransition(workerId, prevStatus, "completed", "validation_passed");
      // A prior PM resolver run that failed (typically a Headers Timeout from
      // the Meridian API while the PM session itself may have completed) for
      // this worker is no longer evidence of failure once the validator has
      // declared the worker healthy. Promote those entries to "completed" so
      // downstream consumers (gate dependencies, UI panels) don't treat a
      // transient PM call failure as a real worker failure.
      reconcilePmResolversForRecoveredWorker(state, workerId, this.log, this.now);
    });
  }

  transitionToValidationFailed(
    workerId: string,
    reason?: string,
    validationResult?: ValidationTransitionResult
  ): void {
    this.mutate((state) => {
      const worker = state.workers[workerId];
      if (!worker) return;

      const prevStatus = worker.status;
      worker.status = "failed";
      if (worker.validation) {
        if (validationResult) {
          recordValidationOutcome(
            workerId,
            worker,
            validationResult.score,
            validationResult.feedback,
            validationResult.validatorThreadId,
            this.now
          );
        } else {
          worker.validation.validator_thread_id = null;
        }
      }
      this.logTransition(workerId, prevStatus, "failed", reason ?? "validation_max_cycles_exhausted");
    });
  }

  // ─── PM resolver lifecycle ───────────────────────────────────────────────

  recordPmResolverStart(
    threadId: string,
    issue: {
      status: string;
      workerId?: string;
      message?: string;
      error?: string;
      source?: string;
    },
    options: {
      agentType?: string;
      modelId?: string;
      mode?: string;
      autoApprove?: boolean;
    } = {}
  ): void {
    this.mutate((state) => {
      const nowIso = this.now();
      const pmResolvers = ensurePmResolverEntries(state);
      const existing = pmResolvers.find((entry) => entry.thread_id === threadId);
      const entry: PmResolverLifecycleState = {
        thread_id: threadId,
        status: "running",
        started_at: existing?.started_at ?? nowIso,
        last_seen_at: nowIso,
        agent_type: options.agentType ?? existing?.agent_type ?? null,
        model_id: options.modelId ?? existing?.model_id ?? null,
        mode: options.mode ?? existing?.mode ?? null,
        auto_approve: options.autoApprove ?? existing?.auto_approve ?? null,
        issue: normalizePmResolverIssue(issue),
        result: existing?.result ?? null,
        error: null,
        transport_error: null,
        marker_outcome: null,
        marker_pm_action: null
      };

      if (existing) {
        Object.assign(existing, entry);
      } else {
        pmResolvers.push(entry);
      }
    });
  }

  recordPmResolverResult(
    threadId: string,
    result: {
      status: string;
      runState?: string;
      content?: string;
      raw?: Record<string, unknown>;
    }
  ): void {
    this.mutate((state) => {
      const entry = ensurePmResolverEntries(state).find((candidate) => candidate.thread_id === threadId);
      if (!entry) {
        return;
      }

      // Phase A primary signal: trust the structured MeridianStatusMarker the
      // PM resolver emits at the end of its reply over envelope status alone.
      // The marker is only honoured when role === "pm-resolver" AND its
      // worker_id matches the issue's target worker; mismatches log and fall
      // through to envelope mapping so cross-talk cannot terminate the wrong
      // PM run.
      const content = pmResolverContentForMarkerScan(result);
      const marker = parseMeridianStatusMarker(content);
      const targetWorkerId = entry.issue?.worker_id ?? null;

      let resolvedStatus: PmResolverLifecycleStatus;
      let signalSource: "marker" | "envelope" = "envelope";
      let bleedError: string | null = null;
      let markerOutcome: PmResolverLifecycleState["marker_outcome"] = null;
      let markerPmAction: PmResolverLifecycleState["marker_pm_action"] = null;
      // top-level if (marker) is intentional — keeps marker.role un-narrowed
      // so the wrong-role branch is type-safe (mirrors validator-orchestrator).
      if (marker) {
        if (marker.role !== "pm-resolver") {
          // Wrong-role marker: the agent at this PM's thread_id replied with
          // a worker/validator marker, which is the canonical signature of a
          // Hub thread-id collision where our PM prompt landed on a live
          // session belonging to another role (root cause of
          // agent-dispatcher-67f6a3fc W-15 codex_58 R-01-validator-bleed,
          // 2026-05-15: codex_58 was spawned as PM for W-15 but emitted a
          // validator marker for the unrelated `in-client-debug-system/R-01`
          // task whose lifecycle had already been torn down so the cross-plan
          // reservation guard returned false). Force-fail the entry with a
          // specific bleed error so the dispatcher gate (which excludes
          // `failed` PMs) reopens and a fresh PM can spawn on a different id.
          // safeKillPmResolver in pm-resolver.ts then evicts the stale thread.
          bleedError = `thread_id_collision_${marker.role}_bleed`;
          this.log.warn("PM resolver marker wrong role — treating as thread-id collision bleed", {
            event: "pm_resolver_marker_wrong_role_bleed",
            thread_id: threadId,
            target_worker_id: targetWorkerId,
            marker_role: marker.role,
            marker_worker_id: marker.worker_id,
            content_length: content.length
          });
          resolvedStatus = "failed";
        } else if (targetWorkerId !== null && marker.worker_id !== targetWorkerId) {
          // Right-role but worker_id points to a different worker: same bleed
          // shape — the agent's prior context drove its reply, not our prompt.
          bleedError = `thread_id_collision_pm_resolver_worker_mismatch`;
          this.log.warn("PM resolver marker worker mismatch — treating as thread-id collision bleed", {
            event: "pm_resolver_marker_worker_mismatch_bleed",
            thread_id: threadId,
            target_worker_id: targetWorkerId,
            marker_worker_id: marker.worker_id,
            marker_role: marker.role,
            content_length: content.length
          });
          resolvedStatus = "failed";
        } else {
          this.log.info("PM resolver decided via marker", {
            event: "pm_resolver_marker_decision",
            thread_id: threadId,
            worker_id: marker.worker_id,
            outcome: marker.outcome,
            pm_action: marker.pm_action ?? null
          });
          const markerStatus: PmResolverLifecycleStatus = marker.outcome === "resolved" ? "completed" : "failed";
          // Still let reconcile promote a "failed" outcome if the target
          // worker landed healthy, mirroring the envelope path so an
          // escalation that succeeds in parallel doesn't show "failed".
          resolvedStatus = reconcilePmStatusAgainstWorkerState(state, entry, markerStatus);
          signalSource = "marker";
          markerOutcome = marker.outcome;
          markerPmAction = marker.pm_action ?? null;
        }
      } else {
        // No marker — use envelope mapping (existing behavior).
        resolvedStatus = reconcilePmStatusAgainstWorkerState(state, entry, mapPmResolverRunStatus(result));
      }

      this.log.info("PM resolver signal source", {
        event: "pm_resolver_signal_source",
        thread_id: threadId,
        signal_source: signalSource,
        result: resolvedStatus
      });

      entry.status = resolvedStatus;
      entry.last_seen_at = this.now();
      entry.result = normalizePmResolverResult(result);
      if (bleedError) {
        entry.error = bleedError;
      } else {
        entry.error = entry.status === "failed" ? entry.error : null;
      }
      entry.marker_outcome = markerOutcome;
      entry.marker_pm_action = markerPmAction;
      // The run completed end-to-end (no transport rejection), so any prior
      // transport-stall annotation is stale. Clear it.
      entry.transport_error = null;
      appendPmResolverReportHistory(state, entry, entry.result?.content ?? null);
    });
  }

  /**
   * Record a transport-level rejection of the PM run promise (hub overload,
   * Meridian-API unreachable, request timeout) WITHOUT killing the thread or
   * flipping status to "failed". The PM session may still be alive at the
   * agent-process level, so we keep `status: "running"` and let the operator
   * talk into it via the GUI talk-box. The reconciler still promotes this
   * entry to `completed` if the target worker reaches a healthy state.
   */
  recordPmResolverTransportStall(threadId: string, errorMessage: string): void {
    this.mutate((state) => {
      const entry = ensurePmResolverEntries(state).find((candidate) => candidate.thread_id === threadId);
      if (!entry) {
        return;
      }
      entry.last_seen_at = this.now();
      entry.transport_error = errorMessage;
      this.log.info("PM resolver transport stall — thread retained for human takeover", {
        event: "pm_resolver_transport_stall",
        thread_id: threadId,
        worker_id: entry.issue?.worker_id ?? null,
        error: errorMessage
      });
    });
  }

  /**
   * Demote a PM resolver entry whose Hub thread is no longer registered
   * (typically observed at startup probe after a meridian-roles or Hub
   * restart killed the agent process while the PM was mid-resolution).
   *
   * Treated as a `failed` envelope: the PM run never delivered a verdict, so
   * the dispatcher needs to be unblocked. The shared
   * `reconcilePmStatusAgainstWorkerState` still promotes this to `completed`
   * if the target worker has independently reached a healthy state — same
   * contract as the post-recovery reconciliation path.
   */
  markPmResolverThreadMissing(threadId: string, reason: string): void {
    this.mutate((state) => {
      const entry = ensurePmResolverEntries(state).find((candidate) => candidate.thread_id === threadId);
      if (!entry || entry.status !== "running") {
        return;
      }

      const reconciled = reconcilePmStatusAgainstWorkerState(state, entry, "failed");
      entry.status = reconciled;
      entry.last_seen_at = this.now();
      entry.error = reconciled === "failed" ? reason : null;
      // Hub no longer routes to this thread id; clear transport_error so the
      // GUI talk-box does not advertise a session that cannot receive input.
      entry.transport_error = null;
      appendPmResolverReportHistory(state, entry, reason);

      this.log.info("PM resolver thread missing on probe", {
        event: "pm_resolver_thread_missing_demotion",
        thread_id: threadId,
        worker_id: entry.issue?.worker_id ?? null,
        signal_source: "envelope",
        result: entry.status,
        reason
      });
    });
  }

  recordPmResolverFailure(threadId: string, error: string): void {
    this.mutate((state) => {
      const entry = ensurePmResolverEntries(state).find((candidate) => candidate.thread_id === threadId);
      if (!entry) {
        return;
      }

      const reconciled = reconcilePmStatusAgainstWorkerState(state, entry, "failed");
      entry.status = reconciled;
      entry.last_seen_at = this.now();
      entry.error = reconciled === "failed" ? error : null;
      appendPmResolverReportHistory(state, entry, error);

      // Phase A6 observability: mirror the signal_source emission shape from
      // recordPmResolverResult so the A7 soak metric (signal_source distribution
      // per role channel) covers the thrown-run failure path. The failure
      // outcome is structured envelope info — there's no agent reply content to
      // parse for a marker — so signal_source is "envelope".
      this.log.info("PM resolver signal source", {
        event: "pm_resolver_signal_source",
        thread_id: threadId,
        worker_id: entry.issue?.worker_id ?? null,
        signal_source: "envelope",
        result: entry.status,
        error
      });
    });
  }
}

interface ValidationTransitionResult {
  score: number;
  feedback: string;
  validatorThreadId: string;
}

// Gate for the awaiting_validation intercept on `completed` results.
//
// First-time entry: status `running` (fresh worker reply) or `fix_requested`
// (validator-feedback rework reply landing through `recordWorkerResult`)
// transition into `awaiting_validation` so the validator can score.
//
// Re-entry after a detour: a worker can reply `outcome: blocked` (or fail)
// while in a fix cycle — e.g. dirty-worktree gate, transient build break.
// `blocked` correctly routes to PM. When the worker subsequently produces a
// passing reply (Attempts 5/6 etc. after PM/operator unblocks the gate),
// `blocked → completed` would normally land directly on `completed`, skipping
// validation entirely even though the validator already gave feedback (cycle
// history > 0). The PR #194 reconciler sweep catches this on the next tick,
// but only on a tick — observed M-01 sat ≥10min waiting for the next
// reconcile while the dispatcher advanced to the next task. Routing the live
// hub_result through the intercept makes the next cycle spawn synchronously.
//
// History-gate (`length > 0`) keeps the original first-entry semantics for
// workers that were `blocked`/`failed` *before* validation ever ran — those
// genuinely did not have a validator decision to revisit, and going to
// `awaiting_validation` would create an unwanted cycle 1 from a status that
// PR #194 will recover separately if appropriate.
export function shouldRouteCompletedToAwaitingValidation(
  worker: DispatchWorkerState
): boolean {
  if (!worker.validation) return false;
  if (worker.status === "running" || worker.status === "fix_requested") {
    return true;
  }
  if (worker.status === "blocked" || worker.status === "failed") {
    return (worker.validation.history?.length ?? 0) > 0;
  }
  return false;
}

function recordValidationOutcome(
  workerId: string,
  worker: DispatchWorkerState,
  score: number,
  feedback: string,
  validatorThreadId: string,
  now: () => string
): void {
  if (!worker.validation) {
    return;
  }

  const cycle = worker.validation.current_cycle + 1;
  const timestamp = now();
  worker.validation.current_cycle = cycle;
  worker.validation.last_score = score;
  worker.validation.last_feedback = feedback;
  worker.validation.validator_thread_id = null;
  // A validator successfully produced a verdict, so any prior consecutive
  // spawn/run failures are no longer evidence of a stuck loop. Reset the
  // backoff counter so future failures (e.g. flaky transport, transient hub
  // FD pressure) start counting from zero instead of compounding indefinitely.
  worker.validation.spawn_failure_count = 0;
  worker.validation.last_spawn_failure_at = null;
  worker.validation.history.push({
    cycle,
    score,
    feedback,
    validator_thread_id: validatorThreadId,
    timestamp
  });
  appendWorkerReportHistory(
    workerId,
    worker,
    `Validator Report - ${workerId} - Cycle ${cycle}`,
    [
      `- Validator Thread: ${validatorThreadId}`,
      `- Score: ${score}`,
      `- Timestamp: ${timestamp}`,
      "",
      "Feedback:",
      "",
      feedback
    ].join("\n")
  );
}

function appendPmResolverReportHistory(
  state: DispatchThreadStateV2,
  entry: PmResolverLifecycleState,
  fallbackText: string | null
): void {
  const workerId = entry.issue?.worker_id?.trim();
  if (!workerId) {
    return;
  }

  const worker = state.workers[workerId];
  if (!worker) {
    return;
  }

  const result = entry.result;
  const body = [
    `- PM Thread: ${entry.thread_id}`,
    `- Status: ${entry.status}`,
    `- Issue: ${entry.issue.status}`,
    `- Source: ${entry.issue.source}`,
    `- Timestamp: ${result?.timestamp ?? entry.last_seen_at}`,
    entry.issue.message ? `- Message: ${entry.issue.message}` : null,
    entry.issue.error ? `- Issue Error: ${entry.issue.error}` : null,
    entry.error ? `- Error: ${entry.error}` : null,
    "",
    result?.content ?? result?.summary_text ?? fallbackText
  ].filter((line): line is string => line !== null && line !== undefined).join("\n");

  appendWorkerReportHistory(workerId, worker, `PM Resolver Report - ${workerId}`, body);
}

function appendWorkerReportHistory(
  workerId: string,
  worker: DispatchWorkerState,
  heading: string,
  body: string
): void {
  const reportPath = resolveWorkerReportPath(worker.expected_outputs, workerId);
  if (!reportPath) {
    return;
  }

  try {
    if (!fs.existsSync(reportPath)) {
      return;
    }
    const section = [
      "",
      "",
      "---",
      "",
      `## ${heading}`,
      "",
      body.trim()
    ].join("\n");
    fs.appendFileSync(reportPath, section.endsWith("\n") ? section : `${section}\n`, "utf8");
  } catch {
    // Report-history append is best-effort. The lifecycle sidecar remains the
    // authoritative status store if a report path is unavailable or read-only.
  }
}

function resolveWorkerReportPath(expectedOutputs: string[], workerId: string): string | null {
  const normalizedWorkerId = workerId.toLowerCase();
  return expectedOutputs.find((outputPath) => {
    const normalized = outputPath.trim().replace(/\\/g, "/").toLowerCase();
    if (!normalized.endsWith(".md")) {
      return false;
    }
    const basename = path.basename(normalized);
    return basename === `${normalizedWorkerId}.md`
      || basename === `${normalizedWorkerId}_report.md`
      || normalized.includes("/reports/")
      || normalized.includes("/dev_history/");
  }) ?? null;
}

function renderPlanMarkdown(state: DispatchThreadStateV2, planTemplate: string): string {
  const lines = planTemplate.split(/\r?\n/);

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerCells = parseTableRow(lines[index]);
    if (!headerCells) {
      continue;
    }

    const normalizedHeaders = headerCells.map(normalizeHeaderCell);
    const statusColumn = normalizedHeaders.indexOf("status");
    const workerColumn = normalizedHeaders.indexOf("worker");
    if (statusColumn === -1 || workerColumn === -1) {
      continue;
    }

    const separatorCells = parseTableRow(lines[index + 1]);
    if (!separatorCells || separatorCells.length !== headerCells.length || !isSeparatorRow(separatorCells)) {
      continue;
    }

    let mutated = false;
    const nextLines = [...lines];

    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const rowCells = parseTableRow(lines[rowIndex]);
      if (!rowCells || rowCells.length !== headerCells.length) {
        break;
      }

      const workerState = state.workers[rowCells[workerColumn]];
      if (!workerState) {
        continue;
      }

      // Never downgrade a confirmed-terminal plan status unless the worker
      // output itself contains stop evidence. A stale ✅ must not hide a
      // failed or blocked acceptance report.
      const currentPlanStatus = rowCells[statusColumn].trim();
      const nextPlanStatus = resolveDisplayStatus(workerState);
      const hasStopEvidence =
        workerState.status === "failed" ||
        workerState.status === "blocked" ||
        (workerState.hub_result ? hubResultContainsFailureSignal(workerState.hub_result) : false);
      const isValidationOwnedStatus =
        workerState.status === "awaiting_validation" || workerState.status === "fix_requested";
      if (
        isPlanStatusTerminalSuccess(currentPlanStatus)
        && nextPlanStatus !== currentPlanStatus
        && nextPlanStatus !== PLAN_STATUS_SYMBOLS.running
        && !isValidationOwnedStatus
        && !hasStopEvidence
      ) {
        continue;
      }

      rowCells[statusColumn] = nextPlanStatus;
      nextLines[rowIndex] = formatTableRow(rowCells);
      mutated = true;
    }

    if (mutated) {
      return preserveTrailingNewline(planTemplate, nextLines.join("\n"));
    }

    break;
  }

  return planTemplate;
}

export function buildEmptyDispatchThreadStateV2(): DispatchThreadStateV2 {
  return {
    version: 2,
    dispatcher: {
      thread_id: null,
      started_at: null,
      status: "pending"
    },
    workers: {},
    pm_resolvers: [],
    last_reconciled_at: null
  };
}

function isDispatchThreadStateV2(value: unknown): boolean {
  return typeof value === "object" && value !== null && "version" in value && value.version === 2;
}

function migrateLegacyState(value: unknown): DispatchThreadStateV2 {
  const legacyState = LegacyDispatchThreadFileSchema.parse(value);
  const workers = Object.fromEntries(
    Object.entries(legacyState.workers).map(([workerId, entry]) => {
      if (typeof entry === "string") {
        return [
          workerId,
          {
            thread_id: entry,
            trace_id: null,
            started_at: EPOCH_ISO,
            last_seen_at: EPOCH_ISO,
            status: "running",
            expected_outputs: [],
            hub_result: null,
            retry_count: 0
          }
        ];
      }

      const startedAt = entry.started_at ?? EPOCH_ISO;
      return [
        workerId,
        {
          thread_id: entry.thread_id,
          trace_id: null,
          started_at: startedAt,
          last_seen_at: startedAt,
          status: "running",
          expected_outputs: [],
          hub_result: null,
          retry_count: 0
        }
      ];
    })
  );

  return DispatchThreadStateV2Schema.parse({
    version: 2,
    dispatcher: legacyState.dispatcher_thread_id
      ? {
          thread_id: legacyState.dispatcher_thread_id,
          started_at: EPOCH_ISO,
          status: "running"
        }
      : {
          thread_id: null,
          started_at: null,
          status: "pending"
        },
    workers,
    pm_resolvers: [],
    last_reconciled_at: null
  });
}

function ensurePmResolverEntries(state: DispatchThreadStateV2): PmResolverLifecycleState[] {
  state.pm_resolvers ??= [];
  return state.pm_resolvers;
}

function normalizePmResolverIssue(issue: {
  status: string;
  workerId?: string;
  message?: string;
  error?: string;
  source?: string;
}): PmResolverIssueState {
  return {
    status: issue.status,
    worker_id: issue.workerId ?? null,
    message: issue.message ?? null,
    error: issue.error ?? null,
    source: issue.source ?? "dispatcher"
  };
}

// PM-resolved worker statuses — if the target worker has reached one of these
// since PM started, the orchestration intent was satisfied even when the run
// envelope reports an error/timeout (e.g. token-cap stop, late hub disconnect
// after the meridian-tool calls already succeeded).
//
// `pending` is included because a PM that calls `resume-worker --action retry`
// resets the worker to `pending` so the dispatcher can relaunch it. Without
// `pending` here, the PM stayed `running` after the retry tool call landed,
// `findActivePmResolversForWorker` kept the relaunch gate closed, and the
// dispatcher deadlocked on the next continue tick until a service restart
// probed the dead PM thread (BATCH-7-GATE on agent-dispatcher-9fd97803).
const PM_RESOLVED_TARGET_STATUSES = new Set<LifecycleStatus>([
  "completed",
  "running",
  "pending",
  "awaiting_validation",
  "fix_requested",
  "skipped"
]);

function reconcilePmStatusAgainstWorkerState(
  state: DispatchThreadStateV2,
  entry: PmResolverLifecycleState,
  envelopeStatus: PmResolverLifecycleStatus
): PmResolverLifecycleStatus {
  if (envelopeStatus !== "failed") {
    return envelopeStatus;
  }

  const targetWorkerId = entry.issue?.worker_id;
  if (!targetWorkerId) {
    return envelopeStatus;
  }

  const target = state.workers[targetWorkerId];
  if (!target) {
    return envelopeStatus;
  }

  return PM_RESOLVED_TARGET_STATUSES.has(target.status) ? "completed" : "failed";
}

// Promote PM resolver entries for `workerId` to "completed" when the worker
// has just reached a healthy state. A failed PM entry usually corresponds to a
// Meridian API timeout after the PM action already landed. A running PM entry
// usually means the PM agent used `update-status` successfully but the service
// did not record the PM run result before restart/transport loss. Either way,
// once the worker is healthy, the PM issue is resolved.
function reconcilePmResolversForRecoveredWorker(
  state: DispatchThreadStateV2,
  workerId: string,
  log: Pick<Logger, "info" | "warn">,
  now: () => string
): void {
  const target = state.workers[workerId];
  if (!target || !PM_RESOLVED_TARGET_STATUSES.has(target.status)) {
    return;
  }
  const entries = state.pm_resolvers ?? [];
  if (entries.length === 0) {
    return;
  }
  const nowIso = now();
  for (const entry of entries) {
    if (entry.status !== "failed" && entry.status !== "running") {
      continue;
    }
    if ((entry.issue?.worker_id ?? "").trim() !== workerId) {
      continue;
    }
    // Thread-id collision bleed failures must stay `failed` even if the
    // worker subsequently recovers via a different PM/operator — promoting
    // them to `completed` would hide the underlying Hub-allocator collision
    // from the dispatcher's "PM already handled" gate and risk the same
    // wrong-context PM reply being treated as a real verdict.
    if (entry.error && entry.error.startsWith("thread_id_collision_")) {
      continue;
    }
    const previousStatus = entry.status;
    const previousError = entry.error;
    entry.status = "completed";
    entry.last_seen_at = nowIso;
    if (!entry.result) {
      entry.result = {
        status: "recovered",
        run_state: "completed",
        content: [
          `PM resolver ${entry.thread_id} completed because worker ${workerId} recovered to ${target.status}.`,
          previousError ? `Original PM transport error: ${previousError}` : null
        ].filter((line): line is string => Boolean(line)).join("\n"),
        summary_text: null,
        details_text: null,
        trace_id: null,
        timestamp: nowIso
      };
    }
    entry.error = null;
    appendPmResolverReportHistory(state, entry, previousError);
    log.info("PM resolver reconciled after worker recovery", {
      event: "pm_resolver_recovered_after_worker_recovery",
      thread_id: entry.thread_id,
      from_status: previousStatus,
      worker_id: workerId,
      worker_status: target.status
    });
  }
}

function mapPmResolverRunStatus(result: {
  status: string;
  runState?: string;
}): PmResolverLifecycleStatus {
  const status = result.status.trim().toLowerCase();
  const runState = result.runState?.trim().toLowerCase() ?? "";
  if (status === "error" || status === "failed" || runState === "error" || runState === "failed" || runState === "timeout") {
    return "failed";
  }

  return "completed";
}

function normalizePmResolverResult(result: {
  status: string;
  runState?: string;
  content?: string;
  raw?: Record<string, unknown>;
}): PmResolverResultState {
  return {
    status: result.status,
    run_state: result.runState ?? readStringField(result.raw, "run_state") ?? null,
    content: result.content ?? readStringField(result.raw, "content") ?? null,
    summary_text: readStringField(result.raw, "summary_text"),
    details_text: readStringField(result.raw, "details_text"),
    trace_id: readStringField(result.raw, "trace_id"),
    timestamp: readDatetimeField(result.raw, "timestamp")
  };
}

function readStringField(raw: Record<string, unknown> | undefined, field: string): string | null {
  const value = raw?.[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readDatetimeField(raw: Record<string, unknown> | undefined, field: string): string | null {
  const value = readStringField(raw, field);
  if (!value) {
    return null;
  }

  return Number.isNaN(Date.parse(value)) ? null : value;
}

type LifecycleSignalSource = "marker" | "heuristic" | "envelope" | "none";

interface LifecycleStatusDecision {
  status: LifecycleStatus;
  signalSource: LifecycleSignalSource;
}

function mapHubResultToLifecycleStatus(
  workerId: string,
  hubResult: HubResult,
  expectedOutputs: string[],
  startedAt: string,
  log?: Pick<Logger, "info" | "warn">,
  fallbackHeuristicsEnabled: boolean = true
): LifecycleStatusDecision {
  const deferSuccessUntilReconciled = requiresOutputVerification(expectedOutputs);

  // Envelope-level error short-circuit (structured signal, NOT heuristic).
  // Always fires regardless of the fallback gate so the worker channel still
  // surfaces hard hub errors even when narrative heuristics are disabled.
  if (hubResult.status === "error") {
    return { status: "failed", signalSource: "envelope" };
  }

  // Envelope-level timeout (structured signal, NOT heuristic). The relay/hub
  // timed out — the worker itself may still be running — so we keep
  // "running" and let the reconciler validate the thread.
  if (hubResult.status === "timeout" || hubResult.run_state === "timeout") {
    return { status: "running", signalSource: "envelope" };
  }

  // Phase A primary signal: trust the structured MeridianStatusMarker
  // emitted by worker agents over narrative heuristics. The marker is only
  // honoured when role === "worker" AND its worker_id matches the launched
  // worker; mismatches log and fall through to the heuristic chain so
  // accidental cross-talk cannot terminate the wrong worker.
  //
  // The marker parse runs BEFORE hubResultContainsHitLimit so that a worker
  // emitting outcome: complete is not pre-empted by an incidental "hit
  // limit"/"token limit" mention in its narrative. A worker that genuinely
  // ran out of context emits outcome: hit_limit and is mapped to "failed"
  // by the switch below; the heuristic only needs to fire when no marker
  // was emitted.
  const marker = parseMeridianStatusMarker(combineHubResultText(hubResult));
  if (marker) {
    if (marker.role !== "worker") {
      // Wrong-role marker (e.g. validator output landing in worker channel).
      // Ignore and fall through, but log so the cross-channel leak is visible.
      log?.info("Lifecycle marker wrong role", {
        event: "marker_wrong_role",
        worker_id: workerId,
        marker_role: marker.role,
        marker_worker_id: marker.worker_id
      });
    } else if (marker.worker_id !== workerId) {
      log?.info("Lifecycle marker mismatch", {
        event: "marker_mismatch",
        worker_id: workerId,
        marker_worker_id: marker.worker_id,
        marker_role: marker.role
      });
    } else {
      // Symmetric positive log with validator-orchestrator and pm-resolver:
      // emit once before the switch so any honoured outcome is observable
      // from a single log site rather than five per-arm sites.
      log?.info("Lifecycle decided via marker", {
        event: "marker_decision",
        worker_id: workerId,
        outcome: marker.outcome
      });
      const markerStatus = mapWorkerMarkerOutcome(
        marker,
        expectedOutputs,
        startedAt,
        deferSuccessUntilReconciled
      );
      return { status: markerStatus, signalSource: "marker" };
    }
  }

  // No usable marker. The fallback chain below is HEURISTIC-only — gate it
  // behind `fallbackHeuristicsEnabled`. With the gate off, return "running"
  // so the reconciler retries (RECONCILABLE_STATUSES = {running, abandoned}).
  // The trivial-success branch (envelope success + no expected_outputs) is
  // kept active because it relies on the structured envelope, not narrative
  // signal.
  if (!fallbackHeuristicsEnabled) {
    if (
      hubResult.status === "success"
      && (!hubResult.run_state || hubResult.run_state === "completed")
      && !deferSuccessUntilReconciled
    ) {
      return { status: "completed", signalSource: "envelope" };
    }
    return { status: "running", signalSource: "none" };
  }

  const heuristicStatus = applyHeuristicFallback(
    workerId,
    hubResult,
    expectedOutputs,
    startedAt,
    deferSuccessUntilReconciled
  );
  return { status: heuristicStatus, signalSource: "heuristic" };
}

function mapWorkerMarkerOutcome(
  marker: { outcome: "complete" | "failed" | "blocked" | "hit_limit" | "needs_pm" },
  expectedOutputs: string[],
  startedAt: string,
  deferSuccessUntilReconciled: boolean
): LifecycleStatus {
  switch (marker.outcome) {
    case "complete":
      if (
        !deferSuccessUntilReconciled
        || expectedOutputsExist(expectedOutputs, startedAt)
      ) {
        return "completed";
      }
      // Marker is a claim; without artifact verification we keep "running"
      // so the reconciler retries.
      return "running";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "hit_limit":
      return "failed";
    case "needs_pm":
      return "blocked";
    default: {
      // Exhaustiveness guard: if WorkerStatusMarker.outcome ever gains a new
      // value, this assertion turns the omission into a TS compile error
      // rather than a silent fall-through.
      const _exhaustive: never = marker.outcome;
      throw new Error(
        `Unhandled worker marker outcome: ${(_exhaustive as unknown as string) ?? "unknown"}`
      );
    }
  }
}

function applyHeuristicFallback(
  workerId: string,
  hubResult: HubResult,
  expectedOutputs: string[],
  startedAt: string,
  deferSuccessUntilReconciled: boolean
): LifecycleStatus {
  if (hubResultContainsHitLimit(hubResult)) {
    return "failed";
  }

  // Authoritative completion gate: when the hub envelope reports
  // success/completed AND the worker's expected output artifacts exist
  // freshly AND those artifacts themselves do not contain block/fail
  // signals, trust the structured evidence over narrative heuristics.
  // Without this gate, false-positive matches in the worker's progress
  // narrative (e.g. "smoke is blocked by the query wrapper, switching to …")
  // override real completion and trigger PM resolution for a successful run.
  if (
    hubResult.status === "success"
    && (!hubResult.run_state || hubResult.run_state === "completed")
    && deferSuccessUntilReconciled
    && expectedOutputsExist(expectedOutputs, startedAt)
    && !outputArtifactsContainBlockSignal(expectedOutputs, startedAt, workerId)
    && !outputArtifactsContainFailureSignal(expectedOutputs, startedAt, workerId)
  ) {
    return "completed";
  }

  if (hubResultContainsBlockSignal(hubResult)) {
    return "blocked";
  }

  if (hubResultContainsFailureSignal(hubResult)) {
    return "failed";
  }

  if (outputArtifactsContainBlockSignal(expectedOutputs, startedAt, workerId)) {
    return "blocked";
  }

  if (outputArtifactsContainFailureSignal(expectedOutputs, startedAt, workerId)) {
    return "failed";
  }

  if (isNonCompletionContent(hubResult.content)) {
    return "running";
  }

  if (hubResult.status === "success" && (!hubResult.run_state || hubResult.run_state === "completed")) {
    if (!deferSuccessUntilReconciled) {
      return "completed";
    }

    if (
      expectedOutputsExist(expectedOutputs, startedAt)
      || reportedOutputsExist(hubResult, expectedOutputs, startedAt)
      || (hubResultContainsInlineReport(hubResult) && hubResultReferencesWorker(hubResult, workerId))
    ) {
      return "completed";
    }

    // Lightweight tasks (e.g. PRE-FLIGHT) may signal completion with an
    // explicit marker like "✅" + "complete" without producing output files
    // or inline reports. Trust the explicit signal.
    if (isExplicitCompletionContent(hubResult.content) && hubResultReferencesWorker(hubResult, workerId)) {
      return "completed";
    }

    return "running";
  }

  // Even when run_state is not "completed" (e.g. "still_running"), trust
  // explicit completion markers in the content. The worker may have finished
  // its task while the thread remains alive.
  if (hubResult.status === "success" && isExplicitCompletionContent(hubResult.content)) {
    if (deferSuccessUntilReconciled && !hubResultReferencesWorker(hubResult, workerId)) {
      return "running";
    }
    return "completed";
  }

  return "running";
}

// FALLBACK ONLY — primary signal is parseMeridianStatusMarker. Do not extend; update the marker schema instead.
const NON_COMPLETION_PATTERNS = [
  /⏸\s*PAUSE/,
  /⛔\s*BLOCKED/,
  /PAUSE\s*[—–-]/,
  /BLOCKED\s*[—–-]/,
  /\bstill\s+running\b/i,
  /\bnot\s+complete\b/i,
  /\bhas\s+not\s+exited\b/i,
  /\bno\s+completion\s+report\b/i,
  /\bno\s+final\s+exit\s+code\b/i
];

// FALLBACK ONLY — primary signal is parseMeridianStatusMarker. Do not extend; update the marker schema instead.
const HIT_LIMIT_PATTERNS = [
  /(?:^|[\s>])[:;=-]?\s*hit\s+limit\b/i,
  /\bcontext(?:\s+window)?\s+limit\b/i,
  /\btoken\s+limit\b/i
];

// FALLBACK ONLY — primary signal is parseMeridianStatusMarker. Do not extend; update the marker schema instead.
const STRUCTURED_FAILURE_SIGNAL_PATTERNS = [
  /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*|__)?(?:Outcome|Status|Result)(?:\*\*|__)?\s*:?\s*`?\s*(?:⛔\s*)?(?:FAIL|FAILED|BLOCKED)\b/i,
  /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*|__)?(?:Outcome|Status|Result)(?:\*\*|__)?\s*\n+\s*`?\s*(?:⛔\s*)?(?:FAIL|FAILED|BLOCKED)\b/i,
  /(?:^|\n)\s*(?:#{1,6}\s*)?Outcome\s*\n+\s*`?\s*(?:⛔\s*)?(?:FAIL|FAILED|BLOCKED)\b/i,
  /(?:^|\n)\s*(?:-\s*)?Outcome\s*:?\s*`?\s*(?:⛔\s*)?(?:FAIL|FAILED|BLOCKED)\b/i,
  /(?:^|\n)\s*(?:-\s*)?Status\s*:?\s*`?\s*(?:⛔\s*)?(?:FAIL|FAILED|BLOCKED)\b/i,
  /(?:^|\n)\s*-\s*Result:\s*`?\s*⛔\s*(?:FAILED|BLOCKED)\b/i,
  /(?:^|\n)\s*Result:\s*`?\s*⛔\s*(?:FAILED|BLOCKED)\b/i,
  /(?:^|\n)\s*⛔\s*(?:FAIL|FAILED|BLOCKED)\b/i,
  /(?:^|[.!?]\s*)BLOCKED\s*[—–-]\s*[\w-]+\s*:/i,
  /"result"\s*:\s*"(?:failed|blocked|error)"/i,
  /"exit_code"\s*:\s*[1-9]\d*/i,
  /(?:^|\n)\s*FAIL:\s+/i
];

// FALLBACK ONLY — primary signal is parseMeridianStatusMarker. Do not extend; update the marker schema instead.
const STRUCTURED_BLOCK_SIGNAL_PATTERNS = [
  /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*|__)?(?:Outcome|Status|Result)(?:\*\*|__)?\s*:?\s*`?\s*(?:⛔\s*)?BLOCKED\b/i,
  /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*|__)?(?:Outcome|Status|Result)(?:\*\*|__)?\s*\n+\s*`?\s*(?:⛔\s*)?BLOCKED\b/i,
  /(?:^|\n)\s*(?:#{1,6}\s*)?Outcome\s*\n+\s*`?\s*(?:⛔\s*)?BLOCKED\b/i,
  /(?:^|\n)\s*(?:-\s*)?Outcome\s*:?\s*`?\s*(?:⛔\s*)?BLOCKED\b/i,
  /(?:^|\n)\s*(?:-\s*)?Status\s*:?\s*`?\s*(?:⛔\s*)?BLOCKED\b/i,
  /(?:^|\n)\s*-\s*Result:\s*`?\s*⛔\s*BLOCKED\b/i,
  /(?:^|\n)\s*Result:\s*`?\s*⛔\s*BLOCKED\b/i,
  /(?:^|\n)\s*⛔\s*BLOCKED\b/i,
  /(?:^|[.!?]\s*)BLOCKED\s*[—–-]\s*[\w-]+\s*:/i,
  /"result"\s*:\s*"blocked"/i,
  /\b(?:finished|ended|completed|stopped)\s+as\s+`?BLOCKED`?\b/i,
  /\bBlocking issue:\b/i
];

// FALLBACK ONLY — primary signal is parseMeridianStatusMarker. Do not extend; update the marker schema instead.
const NONZERO_FAILED_COUNT_PATTERN = /"failed"\s*:\s*[1-9]\d*/i;

// FALLBACK ONLY — primary signal is parseMeridianStatusMarker. Do not extend; update the marker schema instead.
const CONTEXTUAL_FAILURE_SIGNAL_PATTERNS = [
  /⛔\s*BLOCKED\b/i,
  /(?:^|[.!?]\s*)BLOCKED\s*[—–-]/i,
  /\bdid\s+not\s+complete\b/i,
  /\b(?:failed|fails|failure|error|errored|crashed|terminated|stopped|aborted)\b[^\n.]{0,80}\bexit\s+code\s*:?\s*`?[1-9]\d*`?/i,
  /\b(?:command|process|script|tool|test|build|check|run)\s+(?:failed|exited|finished|ended|terminated)\s+(?:with\s+)?(?:exit\s+)?code\s*:?\s*`?[1-9]\d*`?/i,
  /\bexited\s+(?:with\s+)?(?:exit\s+)?code\s*:?\s*`?[1-9]\d*`?/i,
  /\b(?:command|process|script|tool|test|build|check|run)\b[^\n]{0,80}\bexited\s+`?[1-9]\d*`?\b/i,
  /\bAI auto-tests failed\b/i,
  /\bauto-?tests?\s+failed\b/i,
  /\btool failure\b/i,
  /\bfailed the worker acceptance checks\b/i,
  /\b(?:finished|ended|completed|stopped)\s+as\s+`?BLOCKED`?\b/i,
  /\bBlocking issue:\b/i,
  /\bWorker\s+`?[\w-]+`?\s+is\s+blocked\b/i,
  /\b`?[\w-]+`?\s+is\s+blocked\b/i,
  /\bblocked by missing upstream artifacts\b/i,
  /\b(?:cannot|can't)\s+(?:proceed|continue|run)\b/i,
  /\bmanifest\b[\s\S]{0,80}\b(?:missing|absent|not found)\b/i,
  /\bI need permission\b/i,
  /\bpermission to read\b/i,
  /\bgrant (?:read )?access\b/i
];

// FALLBACK ONLY — primary signal is parseMeridianStatusMarker. Do not extend; update the marker schema instead.
const BENIGN_FAILURE_CONTEXT_PATTERNS = [
  /\bno\s+blocking\s+issues?\b/i,
  /\b(?:no|zero)\b[^\n]{0,80}\b(?:failed|failures?|blocked|errors?)\b/i,
  /\b0\s+(?:failed|failures?|errors?)\b/i,
  /\bno\s+longer\b[^\n]{0,80}\b(?:fail(?:ed|ure)?|blocked|cannot|can't|missing|permission)\b/i,
  /\b(?:fail(?:ed|ure)?|blocked|cannot|can't|missing|permission)\b[^\n]{0,80}\bno\s+longer\b/i,
  /\b(?:document(?:s|ed|ing)?|regression|coverage|covers|covered|negative\s+(?:case|test|scenario)|test\s+case|scenario)\b/i,
  /\b(?:verified|expected|handled|handles|emits|shows|reports|prevents|fixed)\b[^\n]{0,120}\b(?:fail(?:ed|ure)?|blocked|cannot|can't|missing|permission|exit\s+code|error\s+path)\b/i,
  /\b(?:fail(?:ed|ure)?|blocked|cannot|can't|missing|permission|exit\s+code)\b[^\n]{0,120}\b(?:verified|expected|handled|handles|emits|shows|reports|prevents|fixed)\b/i
];

export function isNonCompletionContent(content: string): boolean {
  return NON_COMPLETION_PATTERNS.some((pattern) => pattern.test(content));
}

/**
 * Returns the PM resolver entries that own the worker — i.e. entries whose
 * `status === "running"` and `issue.worker_id` matches `workerId`. The
 * dispatcher must not relaunch a worker while a PM resolver is actively
 * trying to unblock it; doing so produces parallel agents racing on the
 * same task without any visible status update on the worker bar.
 */
export function findActivePmResolversForWorker(
  state: Pick<DispatchThreadStateV2, "pm_resolvers">,
  workerId: string | null | undefined
): PmResolverLifecycleState[] {
  const trimmed = workerId?.trim();
  if (!trimmed) {
    return [];
  }
  return (state.pm_resolvers ?? []).filter((entry) =>
    entry.status === "running"
    && (entry.issue?.worker_id ?? "").trim() === trimmed
  );
}

export function hasActivePmResolverForWorker(
  state: Pick<DispatchThreadStateV2, "pm_resolvers">,
  workerId: string | null | undefined
): boolean {
  return findActivePmResolversForWorker(state, workerId).length > 0;
}

export function isExplicitCompletionContent(content: string): boolean {
  return /✅/.test(content) && /\bcomplete\b/i.test(content);
}

export function hubResultContainsHitLimit(
  hubResult: Pick<HubResult, "content" | "summary_text" | "details_text">
): boolean {
  return hubResultContainsPattern(hubResult, HIT_LIMIT_PATTERNS);
}

export function hubResultContainsFailureSignal(
  hubResult: Pick<HubResult, "content" | "summary_text" | "details_text">
): boolean {
  const combinedContent = combineHubResultSignalText(hubResult);
  if (combinedContent.length === 0) {
    return false;
  }

  if (STRUCTURED_FAILURE_SIGNAL_PATTERNS.some((pattern) => pattern.test(combinedContent))) {
    return true;
  }

  if (
    NONZERO_FAILED_COUNT_PATTERN.test(combinedContent)
    && !isToleratedItemFailureSummary(combinedContent)
  ) {
    return true;
  }

  return combinedContent
    .split(/\r?\n/)
    .some((line) => {
      const normalized = line.trim();
      return normalized.length > 0
        && !isBenignFailureContextLine(normalized)
        && CONTEXTUAL_FAILURE_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized));
    });
}

export function hubResultContainsBlockSignal(
  hubResult: Pick<HubResult, "content" | "summary_text" | "details_text">
): boolean {
  const combinedContent = combineHubResultSignalText(hubResult);
  if (combinedContent.length === 0) {
    return false;
  }

  if (STRUCTURED_BLOCK_SIGNAL_PATTERNS.some((pattern) => pattern.test(combinedContent))) {
    return true;
  }

  return combinedContent
    .split(/\r?\n/)
    .some((line) => {
      const normalized = line.trim();
      return normalized.length > 0
        && !isBenignFailureContextLine(normalized)
        && (
          /(?:^|[.!?]\s*)BLOCKED\b/i.test(normalized)
          || /\b(?:is|still|remains|remain|was|were)\b[^\n.]{0,80}\bBLOCKED\b/i.test(normalized)
          || /\bblocked by\b/i.test(normalized)
          || /\bWorker\s+`?[\w-]+`?\s+is\s+blocked\b/i.test(normalized)
          || /\b`?[\w-]+`?\s+is\s+blocked\b/i.test(normalized)
        );
    });
}

export function isPmResolverHubResult(
  hubResult: Pick<HubResult, "source" | "content" | "summary_text" | "details_text"> | null | undefined
): boolean {
  if (!hubResult) {
    return false;
  }

  return hubResult.source.trim().toLowerCase() === "pm-resolver";
}

function isToleratedItemFailureSummary(content: string): boolean {
  return hasZeroExitEvidence(content)
    && hasPassingAutoTestEvidence(content)
    && hasItemFailureToleranceEvidence(content);
}

function hasZeroExitEvidence(content: string): boolean {
  return /(?:^|\n)\s*(?:[-*]\s*)?(?:Exit\s+code|Exit\s+Code)\s*:?\s*`?0`?\b/i.test(content)
    || /(?:^|\n)\s*(?:[-*]\s*)?.*\bexit\s+code\s*:?\s*`?0`?\b/i.test(content)
    || /\bcompleted\s+with\s+exit\s+code\s+0\b/i.test(content);
}

function hasPassingAutoTestEvidence(content: string): boolean {
  const section = extractMarkdownSection(content, "AI Auto-Test Results");
  if (!section) {
    return false;
  }

  return /\bPASS\b/.test(section) && !/(?:^|\n)\s*(?:[-*]\s*)?.*\bFAIL\b/.test(section);
}

function hasItemFailureToleranceEvidence(content: string): boolean {
  return (
    /\b(?:per-skill|per-item|item-level)\s+failures?\b/i.test(content)
    && (
      /\bcontinued\s+to\s+(?:successful\s+command\s+)?completion\b/i.test(content)
      || /\bauthoritative\s+worker-level\s+exit\s+status\b/i.test(content)
    )
  ) || (
    /\bpackage\/version\/file\s+payloads?\s+were\s+unavailable\s+from\s+the\s+upstream\s+API\b/i.test(content)
    && /\brecorded\s+by\s+the\s+CLI\b/i.test(content)
  );
}

function extractMarkdownSection(content: string, heading: string): string | null {
  const headingPattern = new RegExp(`(^|\\n)#{1,6}\\s+${escapeRegExp(heading)}\\s*\\n`, "i");
  const match = headingPattern.exec(content);
  if (!match || typeof match.index !== "number") {
    return null;
  }

  const sectionStart = match.index + match[0].length;
  const remaining = content.slice(sectionStart);
  const nextHeading = remaining.search(/\n#{1,6}\s+\S/);
  return nextHeading === -1 ? remaining : remaining.slice(0, nextHeading);
}

function hubResultContainsPattern(
  hubResult: Pick<HubResult, "content" | "summary_text" | "details_text">,
  patterns: RegExp[]
): boolean {
  const combinedContent = combineHubResultSignalText(hubResult);

  return combinedContent.length > 0 && patterns.some((pattern) => pattern.test(combinedContent));
}

function combineHubResultSignalText(
  hubResult: Pick<HubResult, "content" | "summary_text" | "details_text">
): string {
  return [
    hubResult.content,
    hubResult.summary_text,
    extractAgentReplyDetailsText(hubResult.details_text)
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");
}

function extractAgentReplyDetailsText(detailsText: string | null | undefined): string | null {
  if (typeof detailsText !== "string" || detailsText.trim().length === 0) {
    return null;
  }

  const marker = "Agent reply:";
  const markerIndex = detailsText.lastIndexOf(marker);
  if (markerIndex === -1) {
    return detailsText;
  }

  const replyText = detailsText.slice(markerIndex + marker.length).trim();
  return replyText.length > 0 ? replyText : null;
}

function combineHubResultText(
  hubResult: Pick<HubResult, "content" | "summary_text" | "details_text">
): string {
  return [
    hubResult.content,
    hubResult.summary_text,
    hubResult.details_text
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");
}

/**
 * Combines all text fields from a PM resolver run result into a single string
 * for MeridianStatusMarker scanning. PM result shape differs from HubResult:
 * `content` is top-level on the result, while `summary_text` / `details_text`
 * live inside `result.raw`. This mirrors the structure of
 * `combineHubResultText` so all candidate marker locations are covered.
 */
function pmResolverContentForMarkerScan(result: {
  content?: string;
  raw?: Record<string, unknown>;
}): string {
  const summaryText = readStringField(result.raw, "summary_text");
  const detailsText = readStringField(result.raw, "details_text");
  return [result.content, summaryText, detailsText]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");
}

function isBenignFailureContextLine(line: string): boolean {
  return BENIGN_FAILURE_CONTEXT_PATTERNS.some((pattern) => pattern.test(line));
}

function requiresOutputVerification(expectedOutputs: string[]): boolean {
  return expectedOutputs.length > 0;
}

function expectedOutputsExist(expectedOutputs: string[], startedAt?: string): boolean {
  return outputArtifactsExist(expectedOutputs, startedAt);
}

function outputArtifactsContainFailureSignal(
  expectedOutputs: string[],
  startedAt?: string,
  workerId?: string
): boolean {
  return outputArtifactsContain(
    expectedOutputs,
    (content) => {
      const currentAttemptContent = sliceContentFromStartedAt(content, startedAt);
      if (workerId && outputArtifactHasPassingWorkerMarker(currentAttemptContent, workerId)) {
        return false;
      }
      if (outputArtifactHasPassingOutcome(currentAttemptContent)) {
        return false;
      }
      return !outputArtifactHasPassingDecision(currentAttemptContent)
        && hubResultContainsFailureSignal({ content: currentAttemptContent });
    },
    startedAt
  );
}

function outputArtifactsContainBlockSignal(
  expectedOutputs: string[],
  startedAt?: string,
  workerId?: string
): boolean {
  return outputArtifactsContain(
    expectedOutputs,
    (content) => {
      const currentAttemptContent = sliceContentFromStartedAt(content, startedAt);
      if (workerId && outputArtifactHasPassingWorkerMarker(currentAttemptContent, workerId)) {
        return false;
      }
      if (outputArtifactHasPassingOutcome(currentAttemptContent)) {
        return false;
      }
      return !outputArtifactHasPassingDecision(currentAttemptContent)
        && hubResultContainsBlockSignal({ content: currentAttemptContent });
    },
    startedAt
  );
}

function reportedOutputsExist(hubResult: HubResult, expectedOutputs: string[] = [], startedAt?: string): boolean {
  return extractReportedOutputPaths(hubResult).some((filePath) => {
    if (!reportedOutputMatchesExpected(filePath, expectedOutputs)) {
      return false;
    }

    if (!isCompletionArtifactPath(filePath)) {
      return false;
    }

    return outputArtifactsExist([filePath], startedAt);
  });
}

function extractReportedOutputPaths(hubResult: HubResult): string[] {
  const candidateTexts = [
    hubResult.content,
    hubResult.summary_text,
    hubResult.details_text
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const paths = new Set<string>();

  for (const text of candidateTexts) {
    for (const match of text.matchAll(/\/[^\s)`\]'"]+/g)) {
      const candidatePath = normalizeReportedOutputPath(match[0]);
      if (candidatePath) {
        paths.add(candidatePath);
      }
    }
  }

  return [...paths];
}

function normalizeReportedOutputPath(candidatePath: string): string | null {
  const normalized = candidatePath.trim().replace(/[),.;:]+$/g, "").replace(/#[^/]*$/, "");
  if (!path.isAbsolute(normalized)) {
    return null;
  }

  return path.normalize(normalized);
}

function reportedOutputMatchesExpected(reportedPath: string, expectedOutputs: string[]): boolean {
  if (expectedOutputs.length === 0) {
    return true;
  }

  const reportedBasename = path.basename(reportedPath).toLowerCase();
  return expectedOutputs.some((expectedOutput) => {
    const expectedBasename = path.basename(expectedOutput).toLowerCase();
    return computeBasenameVariants(expectedBasename)
      .map((variant) => variant.toLowerCase())
      .includes(reportedBasename);
  });
}

function hubResultReferencesWorker(
  hubResult: Pick<HubResult, "content" | "summary_text" | "details_text">,
  workerId: string
): boolean {
  const normalizedWorkerId = workerId.trim();
  if (normalizedWorkerId.length === 0) {
    return false;
  }

  const combinedContent = combineHubResultText(hubResult);
  if (combinedContent.length === 0) {
    return false;
  }

  return new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(normalizedWorkerId)}($|[^A-Za-z0-9_-])`, "i")
    .test(combinedContent);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function computeBasenameVariants(basename: string): string[] {
  const variants = [basename];
  const reportSuffixMatch = basename.match(/^(.+)_report(\.md)$/i);
  if (reportSuffixMatch) {
    variants.push(`${reportSuffixMatch[1]}${reportSuffixMatch[2]}`);
  } else {
    const extMatch = basename.match(/^(.+)(\.md)$/i);
    if (extMatch) {
      variants.push(`${extMatch[1]}_report${extMatch[2]}`);
    }
  }

  if (/^delta-check_report\.md$/i.test(basename)) {
    variants.push("delta_check_report.md");
  }
  if (/^pr-review_report\.md$/i.test(basename)) {
    variants.push("pr_review_report.md");
  }

  return [...new Set(variants)];
}

function isCompletionArtifactPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const basename = path.basename(normalized);

  return (
    normalized.includes("/dev_history/")
    && (
      /_report\.md$/.test(basename)
      || basename === "delta_check_report.md"
      || basename === "pr_review_report.md"
    )
  ) || (normalized.includes("/reports/") && basename.endsWith(".md"));
}

// FALLBACK ONLY — primary signal is parseMeridianStatusMarker. Do not extend; update the marker schema instead.
const INLINE_REPORT_PATTERNS = [
  /completion\s+report/i,
  /#\s*.+\bvalidation\s+report\b/i,
  /##\s*Files\s+Changed/i,
  /##\s*Sub-task\s+Results/i,
  /##\s*AI\s+Auto-Test\s+Results/i,
  /##\s*Summary\b/i,
  /##\s*Case\s+Results\b/i,
  /##\s*Executive\s+Summary\b/i,
  /##\s*Function\s+Coverage\s+Table\b/i,
  /\bStatus\b.*✅\s*(?:Pass|Complete|Validated)\b/i
];

// FALLBACK ONLY — primary signal is parseMeridianStatusMarker. Do not extend; update the marker schema instead.
const SPECIAL_INLINE_REPORT_PATTERNS = [
  /#\s*.+\bCompletion\s+Report\b/i,
  /#\s*Delta\s+Check\s+Report\b/i,
  /#\s*PR[\s-]*Review\s+Report\b/i
];

function containsInlineReport(content: string): boolean {
  if (SPECIAL_INLINE_REPORT_PATTERNS.some((pattern) => pattern.test(content))) {
    return true;
  }

  return INLINE_REPORT_PATTERNS.filter((pattern) => pattern.test(content)).length >= 2;
}

export function hubResultContainsInlineReport(
  hubResult: Pick<HubResult, "content" | "summary_text" | "details_text">
): boolean {
  const combinedContent = [
    hubResult.content,
    hubResult.summary_text,
    hubResult.details_text
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");

  return combinedContent.length > 0 && containsInlineReport(combinedContent);
}

function cloneWorker(worker: DispatchThreadStateV2["workers"][string]): DispatchThreadStateV2["workers"][string] {
  return {
    ...worker,
    expected_outputs: [...worker.expected_outputs],
    hub_result: worker.hub_result
      ? {
          ...worker.hub_result,
          attachments: worker.hub_result.attachments.map((attachment) => ({ ...attachment }))
        }
      : null
  };
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

function formatTableRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function resolveDisplayStatus(worker: DispatchWorkerState): string {
  if (worker.status === "completed" || worker.status === "skipped") {
    return PLAN_STATUS_SYMBOLS[worker.status];
  }

  if (worker.status !== "blocked" && worker.hub_result && hubResultContainsBlockSignal(worker.hub_result)) {
    return PLAN_STATUS_SYMBOLS.blocked;
  }

  if (
    worker.status !== "failed"
    && worker.status !== "blocked"
    && worker.hub_result
    && hubResultContainsFailureSignal(worker.hub_result)
  ) {
    return PLAN_STATUS_SYMBOLS.failed;
  }

  if (worker.status === "fix_requested" && worker.validation) {
    const { current_cycle, max_fix_cycles } = worker.validation;
    return `🔁 FIX ${current_cycle}/${max_fix_cycles}`;
  }
  return PLAN_STATUS_SYMBOLS[worker.status];
}

function isPlanStatusTerminalSuccess(status: string): boolean {
  return status === "✅" || status === "⛔ SKIPPED";
}

function inferDispatchPlanPath(filePath: string): string {
  const directory = path.dirname(filePath);
  const defaultPlanPath = path.join(directory, DISPATCH_PLAN_FILENAME);
  if (fs.existsSync(defaultPlanPath)) {
    return defaultPlanPath;
  }

  if (path.basename(filePath) !== DISPATCH_THREADS_FILENAME) {
    return defaultPlanPath;
  }

  try {
    const candidates = fs.readdirSync(directory)
      .filter((entry) =>
        entry === DISPATCH_PLAN_FILENAME
        || entry.endsWith("_dispatch_plan.md")
        || entry.endsWith("-dispatch-plan.md")
        || entry.endsWith("-plan.md")
      )
      .sort();
    if (candidates.length === 1) {
      return path.join(directory, candidates[0]!);
    }
  } catch {
    return defaultPlanPath;
  }

  return defaultPlanPath;
}

function preserveTrailingNewline(original: string, updated: string): string {
  return original.endsWith("\n") ? `${updated}\n` : updated;
}

function writeFileAtomically(
  targetFilePath: string,
  payload: string,
  beforeCommit?: (tempFilePath: string, targetFilePath: string) => void
): void {
  const directory = path.dirname(targetFilePath);
  const tempFilePath = `${targetFilePath}.${process.pid}.${Date.now()}.tmp`;

  fs.mkdirSync(directory, { recursive: true });

  try {
    fs.writeFileSync(tempFilePath, payload, "utf8");
    beforeCommit?.(tempFilePath, targetFilePath);
    fs.renameSync(tempFilePath, targetFilePath);
  } catch (error) {
    cleanupTempFile(tempFilePath);
    throw error;
  }
}

function cleanupTempFile(tempFilePath: string): void {
  try {
    fs.unlinkSync(tempFilePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
