import type { Logger } from "../base-role";
import { FALLBACK_HEURISTICS_ENABLED } from "../../config";
import type { DispatchWorkerState, KillPolicy, ValidatorConfig } from "../../types";
import type { LifecycleStore } from "./lifecycle-store";
import {
  parseMeridianStatusMarker,
  type ValidatorStatusMarker
} from "./meridian-status-marker";
import type { MeridianApiClient, MeridianRunResult } from "./meridian-api-client";
import type { DispatchContinuationPlanRow } from "./service-continuation";
import {
  createLifecycleThreadIdCollisionError,
  isLifecycleThreadIdLiveWorkerThread,
  isLifecycleThreadIdReserved,
  killCollidedSpawnedThread
} from "./thread-id-reservation";
import { buildDefaultValidatorPrompt, type ValidatorPromptContext } from "./validator-prompt-builder";

// ─── Types ──────────────────────────────────────────────────────────────────────

export type ValidatorCycleOutcome =
  | { status: "passed"; score: number }
  | { status: "fix_requested"; score: number; cycle: number; maxCycles: number }
  | { status: "failed"; score: number; reason: string }
  | { status: "error"; reason: string };

export interface ValidatorOrchestratorDeps {
  lifecycleStore: LifecycleStore;
  validatorConfig: ValidatorConfig;
  meridianApi: MeridianApiClient;
  killPolicy?: KillPolicy;
  spawnDir: string;
  dispatchPlanPath: string;
  taskspecPath: string | null;
  buildPrompt?: (context: ValidatorPromptContext) => string;
  log: Pick<Logger, "info" | "warn">;
  /**
   * Phase A6 kill-switch override. Production code reads
   * {@link FALLBACK_HEURISTICS_ENABLED} from `src/config.ts`; this option
   * exists so tests can toggle the gate without mutating `process.env`.
   */
  fallbackHeuristicsEnabled?: boolean;
}

export interface ParsedValidatorOutput {
  score: number;
  feedback: string;
  positive?: boolean;
}

// ─── Per-task override parsing ──────────────────────────────────────────────────

const VALIDATE_OFF_PATTERN = /\bvalidate\s*:\s*off\b/i;
const VALIDATE_THRESHOLD_PATTERN = /\bvalidate\s*:\s*threshold\s*=\s*([\d.]+)/i;

const EXCLUDED_MODEL_CODES = new Set(["HUMAN", "PM"]);
const VALIDATOR_SPAWN_MAX_ATTEMPTS = 3;

// Transport-class patterns: when meridianApi.run rejects with one of these,
// the validator agent was spawned successfully but the hub/transport closed
// the request side before delivering a verdict. Treat this as transient (do
// not increment the spawn-failure backoff counter, do not kill the validator
// thread) so a temporarily overloaded hub does not push the worker into a
// 10-minute validation backoff window. Mirrors `SPAWN_TRANSIENT_PATTERNS` in
// `launcher.ts` and the PM-resolver transport-stall pattern.
const VALIDATOR_RUN_TRANSPORT_PATTERNS: readonly RegExp[] = [
  /\bhub may be overloaded\b/i,
  /\bHeaders Timeout\b/i,
  /Meridian API unreachable/i,
  /\bfetch failed\b/i,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /\btimed?\s*out\b/i,
  /service.unavailable/i
];

function isTransportClassRunError(message: string): boolean {
  return VALIDATOR_RUN_TRANSPORT_PATTERNS.some((pattern) => pattern.test(message));
}

export function isValidationEnabledForWorker(
  config: ValidatorConfig,
  planRow: DispatchContinuationPlanRow
): boolean {
  if (!config.enabled) {
    return false;
  }

  if (planRow.model && EXCLUDED_MODEL_CODES.has(planRow.model.trim().toUpperCase())) {
    return false;
  }

  const notes = planRow.notes ?? "";
  if (VALIDATE_OFF_PATTERN.test(notes)) {
    return false;
  }

  return true;
}

export function resolveThresholdForWorker(
  config: ValidatorConfig,
  planRow: DispatchContinuationPlanRow
): number {
  const notes = planRow.notes ?? "";
  const match = VALIDATE_THRESHOLD_PATTERN.exec(notes);
  if (match?.[1]) {
    const parsed = parseFloat(match[1]);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
      return parsed;
    }
  }

  return config.pass_threshold;
}

// ─── Completion interception ────────────────────────────────────────────────────

export function interceptCompletionForValidation(
  lifecycleStore: LifecycleStore,
  validatorConfig: ValidatorConfig,
  workerId: string,
  planRow: DispatchContinuationPlanRow
): boolean {
  if (!isValidationEnabledForWorker(validatorConfig, planRow)) {
    return false;
  }

  lifecycleStore.transitionToAwaitingValidation(workerId, validatorConfig.max_fix_cycles);
  return true;
}

// ─── Validation cycle execution ─────────────────────────────────────────────────

export async function executeValidationCycle(
  deps: ValidatorOrchestratorDeps,
  workerId: string,
  planRow: DispatchContinuationPlanRow
): Promise<ValidatorCycleOutcome> {
  const { lifecycleStore, validatorConfig, meridianApi, log } = deps;

  const state = lifecycleStore.load();
  const worker = state.workers[workerId];
  if (!worker || worker.status !== "awaiting_validation") {
    return { status: "error", reason: `worker ${workerId} not in awaiting_validation state` };
  }

  const validation = worker.validation;
  if (!validation) {
    return { status: "error", reason: `worker ${workerId} has no validation state` };
  }

  const thresholdType = validatorConfig.threshold_type ?? "score";
  const threshold = thresholdType === "score"
    ? resolveThresholdForWorker(validatorConfig, planRow)
    : null;
  const baseBranch = validatorConfig.base_branch;
  const taskBranch = resolveTaskBranch(workerId);
  const cycle = validation.current_cycle + 1;

  const promptContext: ValidatorPromptContext = {
    workerId,
    taskBranch,
    baseBranch,
    taskspecPath: deps.taskspecPath,
    dispatchPlanPath: deps.dispatchPlanPath,
    cycle,
    maxFixCycles: validation.max_fix_cycles,
    previousFeedback: validation.last_feedback,
    thresholdType
  };

  const promptBuilder = deps.buildPrompt ?? buildDefaultValidatorPrompt;
  const prompt = promptBuilder(promptContext);

  // Spawn validator agent
  let validatorThreadId: string;
  try {
    validatorThreadId = await spawnValidatorWithReservedThreadRetry(deps);
    lifecycleStore.recordValidatorStart(workerId, validatorThreadId);
    log.info("Validator spawned", {
      event: "validator_spawned",
      worker_id: workerId,
      validator_thread_id: validatorThreadId,
      cycle
    });
  } catch (error) {
    const reason = `failed to spawn validator: ${asErrorMessage(error)}`;
    log.warn("Validator spawn failed", { event: "validator_spawn_error", worker_id: workerId, error: reason });
    lifecycleStore.recordValidatorSpawnFailure(workerId);
    return { status: "error", reason };
  }

  // Run validator
  let runResult;
  try {
    runResult = await meridianApi.run({
      threadId: validatorThreadId,
      content: prompt
    });
  } catch (error) {
    const errorMessage = asErrorMessage(error);
    const reason = `validator run failed: ${errorMessage}`;
    // Transport-class rejection (hub overload, Meridian-API unreachable,
    // request timeout, IPC drop). The validator agent process may still be
    // alive — only the request-side promise rejected. Do NOT count this
    // toward the spawn-failure backoff (otherwise 3 hub-overload responses in
    // a row drive the worker into a 10-minute stall even though the validator
    // never had a chance to verdict). The validator is ephemeral, so we
    // still safeKill the thread; we just skip the backoff bump and let the
    // next continue tick re-spawn cleanly. Mirrors PR #185.
    if (isTransportClassRunError(errorMessage)) {
      log.warn("Validator run hit transport-class error; not counting as spawn failure", {
        event: "validator_run_transport_stall",
        worker_id: workerId,
        validator_thread_id: validatorThreadId,
        error: reason
      });
      await safeKill(meridianApi, validatorThreadId, log);
      lifecycleStore.clearValidatorStartTransportStall(workerId, validatorThreadId);
      return { status: "error", reason };
    }
    log.warn("Validator run failed", { event: "validator_run_error", worker_id: workerId, error: reason });
    await safeKill(meridianApi, validatorThreadId, log);
    lifecycleStore.clearValidatorStart(workerId, validatorThreadId);
    return { status: "error", reason };
  }

  // Kill validator (ephemeral)
  await safeKill(meridianApi, validatorThreadId, log);

  // Parse result — marker first, JSON fallback (gated)
  const content = runResult.content ?? "";
  const marker = parseMeridianStatusMarker(content);

  if (marker && marker.role === "validator" && marker.worker_id === workerId) {
    log.info("Validator signal source", {
      event: "validator_signal_source",
      worker_id: workerId,
      signal_source: "marker",
      result: marker.outcome
    });
    return await handleValidatorMarker(
      deps,
      workerId,
      validatorThreadId,
      validation,
      worker,
      marker
    );
  }

  if (marker) {
    if (marker.role !== "validator") {
      log.warn("Validator marker wrong role", {
        event: "validator_marker_wrong_role",
        worker_id: workerId,
        marker_role: marker.role,
        marker_worker_id: "worker_id" in marker ? marker.worker_id : null,
        content_length: content.length
      });
    } else if (marker.worker_id !== workerId) {
      log.warn("Validator marker mismatch", {
        event: "validator_marker_mismatch",
        worker_id: workerId,
        marker_worker_id: marker.worker_id,
        marker_role: marker.role,
        content_length: content.length
      });
    }
  }

  // Phase A6 kill-switch: when fallback heuristics are disabled and no
  // usable marker was emitted, do NOT run the JSON-fallback parser. Return
  // an error outcome so the caller can decide how to proceed; mirror the
  // existing parse-error cleanup path (clearValidatorStart) so the worker's
  // validation slot is not held by an orphaned validator thread.
  const fallbackHeuristicsEnabled = deps.fallbackHeuristicsEnabled ?? FALLBACK_HEURISTICS_ENABLED;
  if (!fallbackHeuristicsEnabled) {
    log.info("Validator signal source", {
      event: "validator_signal_source",
      worker_id: workerId,
      signal_source: "none",
      result: "error"
    });
    lifecycleStore.clearValidatorStart(workerId, validatorThreadId);
    return { status: "error", reason: "no marker; fallback disabled" };
  }

  const parsed = parseValidatorOutputFromJson(content);
  if (!parsed) {
    log.warn("Validator output unparseable", {
      event: "validator_parse_error",
      worker_id: workerId,
      content_length: content.length
    });
    log.info("Validator signal source", {
      event: "validator_signal_source",
      worker_id: workerId,
      signal_source: "none",
      result: "error"
    });
    lifecycleStore.clearValidatorStart(workerId, validatorThreadId);
    return { status: "error", reason: "could not parse validator output" };
  }

  log.info("Validator signal source", {
    event: "validator_signal_source",
    worker_id: workerId,
    signal_source: "heuristic",
    result: "scored"
  });

  log.info("Validator scored", {
    event: "validator_scored",
    worker_id: workerId,
    score: parsed.score,
    threshold_type: thresholdType,
    ...(threshold === null ? {} : { threshold }),
    positive: parsed.positive,
    cycle
  });

  // Decision gate
  if (isValidatorResultPassing(validatorConfig, planRow, parsed)) {
    lifecycleStore.transitionToValidated(workerId, {
      score: parsed.score,
      feedback: parsed.feedback,
      validatorThreadId
    });
    await safeKillRetainedWorkerAfterValidation(deps, worker.thread_id, "passed");
    return { status: "passed", score: parsed.score };
  }

  if (cycle >= validation.max_fix_cycles) {
    lifecycleStore.transitionToValidationFailed(workerId, "max_cycles_exhausted", {
      score: parsed.score,
      feedback: parsed.feedback,
      validatorThreadId
    });
    await safeKillRetainedWorkerAfterValidation(deps, worker.thread_id, "failed");
    return {
      status: "failed",
      score: parsed.score,
      reason: `max validation cycles exhausted (${validation.max_fix_cycles})`
    };
  }

  lifecycleStore.transitionToFixRequested(
    workerId,
    parsed.score,
    parsed.feedback,
    validatorThreadId
  );

  return {
    status: "fix_requested",
    score: parsed.score,
    cycle,
    maxCycles: validation.max_fix_cycles
  };
}

async function spawnValidatorWithReservedThreadRetry(deps: ValidatorOrchestratorDeps): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < VALIDATOR_SPAWN_MAX_ATTEMPTS; attempt += 1) {
    const spawnResult = await deps.meridianApi.spawn({
      agentType: deps.validatorConfig.agent_type,
      mode: deps.validatorConfig.mode,
      spawnDir: deps.spawnDir,
      modelId: deps.validatorConfig.model_id,
      autoApprove: deps.validatorConfig.mode === "stateless_call" ? false : deps.validatorConfig.auto_approve,
      sandboxMode: deps.validatorConfig.mode === "stateless_call" ? "read-only" : undefined
    });

    // Use the active-reservation check for all modes. The broader
    // "isLifecycleThreadIdKnown" check (which blocked every ID ever seen,
    // including terminal-worker history) caused a deadlock: the Hub recycles
    // killed thread IDs back into its pool rather than advancing past the last
    // known ID, so a long-running dispatcher with many completed workers
    // exhausted the usable ID space and the spawn-retry loop never escaped.
    // Terminal workers' thread IDs are safe to reuse — the agents are dead.
    const isCollision = isLifecycleThreadIdReserved(deps.dispatchPlanPath, spawnResult.threadId);
    if (!isCollision) {
      return spawnResult.threadId;
    }

    // The freshly spawned validator landed on a thread id that is already an
    // active reservation in lifecycle. PR #134 kills the orphan spawn here to
    // prevent leaks. But when the colliding id is the *live worker thread* we
    // are about to validate, killing it terminates the worker agent itself
    // (observed in the Hub UI as "the worker had been killed before validator
    // approval"). Skip the kill in that case and just retry — preferring an
    // orphan leak over taking out the worker we are validating.
    const collidesWithLiveWorker = isLifecycleThreadIdLiveWorkerThread(
      deps.dispatchPlanPath,
      spawnResult.threadId
    );
    if (!collidesWithLiveWorker) {
      await killCollidedSpawnedThread(deps.meridianApi, spawnResult.threadId, "validator spawn");
    }
    lastError = createLifecycleThreadIdCollisionError(spawnResult.threadId);
    if (attempt < VALIDATOR_SPAWN_MAX_ATTEMPTS - 1) {
      deps.log.warn("Validator spawn returned reserved lifecycle thread id, retrying", {
        event: "validator_spawn_thread_id_collision_retry",
        thread_id: spawnResult.threadId,
        attempt: attempt + 1,
        skipped_kill: collidesWithLiveWorker,
        error: lastError.message
      });
    }
  }

  throw lastError ?? new Error("validator spawn failed: no attempts completed");
}

// ─── Feedback delivery ──────────────────────────────────────────────────────────

export type FeedbackDeliveryOutcome =
  | { delivered: true }
  | { delivered: false; reason: "no-op"; detail: string }
  | { delivered: false; reason: "delivery_error"; error: string };

export async function deliverValidatorFeedback(
  deps: ValidatorOrchestratorDeps,
  workerId: string
): Promise<FeedbackDeliveryOutcome> {
  const { lifecycleStore, meridianApi, log } = deps;

  const state = lifecycleStore.load();
  const worker = state.workers[workerId];
  if (!worker || worker.status !== "fix_requested") {
    return { delivered: false, reason: "no-op", detail: `worker ${workerId} not in fix_requested` };
  }

  const validation = worker.validation;
  if (!validation?.last_feedback || validation.last_score === null || validation.last_score === undefined) {
    return { delivered: false, reason: "no-op", detail: `worker ${workerId} missing validation feedback` };
  }

  const feedbackMessage = [
    `[VALIDATOR FEEDBACK] Cycle ${validation.current_cycle}/${validation.max_fix_cycles} | ${formatValidatorFeedbackResult(deps.validatorConfig, validation.last_score)}`,
    "",
    validation.last_feedback,
    "",
    "Please address the above feedback and re-submit your work. When you are done, signal completion as you normally would."
  ].join("\n");

  let markedRunning = false;
  try {
    lifecycleStore.setWorkerStatus(workerId, "running", "validator_feedback_delivered");
    markedRunning = true;
    const runResult = await meridianApi.run({
      threadId: worker.thread_id,
      content: feedbackMessage
    });
    log.info("Validator feedback delivered", {
      event: "validator_feedback_delivered",
      worker_id: workerId,
      worker_thread_id: worker.thread_id,
      cycle: validation.current_cycle
    });
    if (isCompletedRunResult(runResult)) {
      lifecycleStore.setWorkerStatus(workerId, "awaiting_validation", "validator_rework_completed");
    }
  } catch (error) {
    const errorMessage = asErrorMessage(error);
    if (markedRunning) {
      try {
        const latestWorker = lifecycleStore.load().workers[workerId];
        if (latestWorker?.status === "running") {
          lifecycleStore.setWorkerStatus(workerId, "fix_requested", "validator_feedback_error");
        }
      } catch {
        // Leave the original delivery error as the observable failure.
      }
    }
    log.warn("Validator feedback delivery failed", {
      event: "validator_feedback_error",
      worker_id: workerId,
      error: errorMessage
    });
    return { delivered: false, reason: "delivery_error", error: errorMessage };
  }

  return { delivered: true };
}

// ─── Output parsing ─────────────────────────────────────────────────────────────

export function parseValidatorOutputFromJson(content: string): ParsedValidatorOutput | null {
  // Try to find a JSON code block first
  const codeBlockMatch = content.match(/```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/);
  if (codeBlockMatch?.[1]) {
    const result = tryParseJson(codeBlockMatch[1]);
    if (result) {
      return result;
    }
  }

  // Fallback: find last JSON object in content
  const jsonMatches = [...content.matchAll(/\{[^{}]*(?:"score"\s*:|"positive"\s*:|"verdict"\s*:|"result"\s*:)[^{}]*\}/g)];
  if (jsonMatches.length > 0) {
    const lastMatch = jsonMatches[jsonMatches.length - 1]![0];
    const result = tryParseJson(lastMatch);
    if (result) {
      return result;
    }
  }

  return null;
}

export function isValidatorResultPassing(
  config: ValidatorConfig,
  planRow: DispatchContinuationPlanRow,
  result: ParsedValidatorOutput | number
): boolean {
  if ((config.threshold_type ?? "score") === "binary") {
    if (typeof result === "number") {
      return result === 1;
    }

    return result.positive === true;
  }

  const score = typeof result === "number" ? result : result.score;
  return score >= resolveThresholdForWorker(config, planRow);
}

function tryParseJson(raw: string): ParsedValidatorOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.feedback !== "string") {
        return null;
      }

      const feedback = record.feedback;
      const positive = parseBinaryPositive(record.positive)
        ?? parseBinaryPositive(record.verdict)
        ?? parseBinaryPositive(record.result);
      if (positive !== null) {
        return {
          score: positive ? 1 : 0,
          feedback,
          positive
        };
      }

      if (typeof record.score !== "number") {
        return null;
      }

      const score = record.score;
      if (score >= 0 && score <= 1) {
        return { score, feedback };
      }
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

function parseBinaryPositive(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (["positive", "pass", "passed", "true", "ok", "accepted"].includes(normalized)) {
    return true;
  }
  if (["negative", "fail", "failed", "false", "blocked", "rejected"].includes(normalized)) {
    return false;
  }

  return null;
}

function formatValidatorFeedbackResult(config: ValidatorConfig, score: number): string {
  if ((config.threshold_type ?? "score") === "binary") {
    return `Result: ${score === 1 ? "positive" : "negative"}`;
  }

  return `Score: ${score}`;
}

// ─── Marker-based decision flow ─────────────────────────────────────────────────

async function handleValidatorMarker(
  deps: ValidatorOrchestratorDeps,
  workerId: string,
  validatorThreadId: string,
  validation: NonNullable<DispatchWorkerState["validation"]>,
  worker: DispatchWorkerState,
  marker: ValidatorStatusMarker
): Promise<ValidatorCycleOutcome> {
  const score = marker.score ?? defaultScoreForOutcome(marker.outcome);
  const feedback = marker.feedback ?? "";
  const cycle = validation.current_cycle + 1;
  const maxCycles = validation.max_fix_cycles;

  if (marker.score === undefined) {
    deps.log.info("Validator marker score defaulted", {
      event: "validator_marker_score_defaulted",
      worker_id: workerId,
      outcome: marker.outcome,
      default_score: score
    });
  }

  deps.log.info("Validator decided via marker", {
    event: "validator_marker_decision",
    worker_id: workerId,
    outcome: marker.outcome,
    score,
    cycle
  });

  switch (marker.outcome) {
    case "pass": {
      deps.lifecycleStore.transitionToValidated(workerId, {
        score,
        feedback,
        validatorThreadId
      });
      await safeKillRetainedWorkerAfterValidation(deps, worker.thread_id, "passed");
      return { status: "passed", score };
    }
    case "fail": {
      deps.lifecycleStore.transitionToValidationFailed(workerId, "validator_marker_fail", {
        score,
        feedback,
        validatorThreadId
      });
      await safeKillRetainedWorkerAfterValidation(deps, worker.thread_id, "failed");
      return { status: "failed", score, reason: "validator returned fail outcome" };
    }
    case "fix_requested": {
      if (cycle >= maxCycles) {
        deps.lifecycleStore.transitionToValidationFailed(workerId, "max_cycles_exhausted", {
          score,
          feedback,
          validatorThreadId
        });
        await safeKillRetainedWorkerAfterValidation(deps, worker.thread_id, "failed");
        return {
          status: "failed",
          score,
          reason: `max validation cycles exhausted (${maxCycles})`
        };
      }
      deps.lifecycleStore.transitionToFixRequested(workerId, score, feedback, validatorThreadId);
      return { status: "fix_requested", score, cycle, maxCycles };
    }
    default: {
      const _exhaustive: never = marker.outcome;
      throw new Error(`Unhandled validator marker outcome: ${_exhaustive as string}`);
    }
  }
}

function defaultScoreForOutcome(outcome: ValidatorStatusMarker["outcome"]): number {
  switch (outcome) {
    case "pass":
      return 1.0;
    case "fix_requested":
      return 0.5;
    case "fail":
      return 0.0;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function resolveTaskBranch(workerId: string): string {
  // Convention: worker branches use the worker ID as the branch name suffix
  return `task/${workerId.toLowerCase()}`;
}

function isCompletedRunResult(runResult: MeridianRunResult): boolean {
  const status = runResult.status.trim().toLowerCase();
  const runState = runResult.runState?.trim().toLowerCase();
  return status === "success" && (!runState || runState === "completed");
}

async function safeKill(
  meridianApi: MeridianApiClient,
  threadId: string,
  log: Pick<Logger, "warn">
): Promise<void> {
  try {
    await meridianApi.kill(threadId);
  } catch (error) {
    log.warn("Validator kill failed (non-fatal)", {
      event: "validator_kill_error",
      thread_id: threadId,
      error: asErrorMessage(error)
    });
  }
}

async function safeKillRetainedWorkerAfterValidation(
  deps: ValidatorOrchestratorDeps,
  workerThreadId: string,
  outcome: "passed" | "failed"
): Promise<void> {
  const killPolicy = deps.killPolicy ?? "never";
  if (!shouldKillRetainedWorkerAfterValidation(killPolicy, outcome)) {
    return;
  }

  await safeKill(deps.meridianApi, workerThreadId, deps.log);
}

function shouldKillRetainedWorkerAfterValidation(killPolicy: KillPolicy, outcome: "passed" | "failed"): boolean {
  if (killPolicy === "never") {
    return false;
  }

  if (outcome === "failed") {
    return killPolicy === "always";
  }

  return killPolicy === "always" || killPolicy === "on_success";
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
