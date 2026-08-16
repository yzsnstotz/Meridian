import fs from "node:fs";

import type { Logger } from "../base-role";
import { FALLBACK_HEURISTICS_ENABLED } from "../../config";
import type {
  DispatchWorkerState,
  KillPolicy,
  ValidationStateIdentity,
  ValidatorConfig
} from "../../types";
import type { LifecycleStore } from "./lifecycle-store";
import {
  parseMeridianStatusMarker,
  parseValidatorBlocking,
  parseValidatorDelegatable,
  type ValidatorDelegatableEntry,
  type ValidatorStatusMarker
} from "./meridian-status-marker";
import { appendPmClarification } from "./pm-clarification-writer";
import type { MeridianApiClient, MeridianRunResult } from "./meridian-api-client";
import type { DispatchContinuationPlanRow } from "./service-continuation";
import {
  createLifecycleThreadIdCollisionError,
  isLifecycleThreadIdLiveWorkerThread,
  isLifecycleThreadIdReserved,
  isThreadIdReservedAcrossOtherDispatchPlans,
  killCollidedSpawnedThread
} from "./thread-id-reservation";
import {
  buildDefaultValidatorPrompt,
  loadValidatorContextCapsule,
  type ValidatorPromptContext
} from "./validator-prompt-builder";
import { isAgentapiProcessAliveForThread } from "./active-tool-process";
import {
  computeValidationStateIdentity,
  isValidationStateIdentityUnchanged,
  summarizeValidationStateIdentity,
  type ValidationStateIdentityIo
} from "./validation-state-identity";
import { parseDispatchPlanRows } from "../../tool-gateway/tools/dispatch-status";

// ─── Types ──────────────────────────────────────────────────────────────────────

export type ValidatorCycleOutcome =
  | { status: "passed"; score: number }
  | { status: "fix_requested"; score: number; cycle: number; maxCycles: number }
  | { status: "failed"; score: number; reason: string }
  /**
   * The state-identity guard fired: the validator asked for another fix cycle
   * but nothing observable changed since the cycle before, so the row was
   * parked at lifecycle `blocked` for the PM resolver instead of spawning a
   * cycle that cannot produce a different verdict. Terminal for this run of
   * the feedback loop — like `failed`, it is simply "not fix_requested".
   */
  | { status: "blocked"; score: number; reason: string }
  | { status: "error"; reason: string };

export interface ValidatorOrchestratorDeps {
  lifecycleStore: LifecycleStore;
  validatorConfig: ValidatorConfig;
  meridianApi: MeridianApiClient;
  killPolicy?: KillPolicy;
  spawnDir: string;
  dispatchPlanPath: string;
  /**
   * Dispatch plan paths of OTHER active agent-dispatcher roles. Used to refuse
   * a validator spawn whose returned `thread_id` is already reserved by another
   * role's lifecycle sidecar; without it the Hub allocator wrap after a service
   * restart can hand the same `codex_NN` to a validator spawn that another plan
   * still owns as its live worker/validator.
   */
  otherDispatchPlanPaths?: readonly string[];
  taskspecPath: string | null;
  buildPrompt?: (context: ValidatorPromptContext) => string;
  log: Pick<Logger, "info" | "warn">;
  /**
   * Phase A6 kill-switch override. Production code reads
   * {@link FALLBACK_HEURISTICS_ENABLED} from `src/config.ts`; this option
   * exists so tests can toggle the gate without mutating `process.env`.
   */
  fallbackHeuristicsEnabled?: boolean;
  /**
   * Test seams for the state-identity fingerprint (file reads and the
   * `git rev-parse` that resolves a branch head). Production leaves this
   * unset and gets the real filesystem + git.
   */
  stateIdentityIo?: ValidationStateIdentityIo;
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

const GATE_ROW_ID_PATTERN = /(?:^|[-_])GATE$/;
const GATE_ROW_EXACT_IDS = new Set(["INTEGRATE"]);

export function isGateRow(planRow: Pick<DispatchContinuationPlanRow, "worker">): boolean {
  const workerId = planRow.worker?.trim().toUpperCase() ?? "";
  if (!workerId) {
    return false;
  }
  return GATE_ROW_EXACT_IDS.has(workerId) || GATE_ROW_ID_PATTERN.test(workerId);
}

export function isUnvalidatedGateRow(
  planRow: Pick<DispatchContinuationPlanRow, "worker">,
  validation: { history?: unknown[] } | null | undefined
): boolean {
  if (!isGateRow(planRow)) {
    return false;
  }
  return (validation?.history?.length ?? 0) === 0;
}

const VALIDATOR_SPAWN_MAX_ATTEMPTS = 3;
const STALE_OUTPUT_ARTIFACT_FEEDBACK_ERROR = "stale output artifact returned after feedback delivery";

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
  const baseBranch = validatorConfig.base_branch;
  const taskBranch = resolveTaskBranch(workerId, planRow, deps.dispatchPlanPath, log);
  const cycle = validation.current_cycle + 1;

  if (isValidationCycleBudgetExhausted(validation)) {
    log.warn("Validator cycle budget already exhausted; failing worker without spawning validator", {
      event: "validator_cycle_budget_exhausted_pre_spawn",
      worker_id: workerId,
      current_cycle: validation.current_cycle,
      max_fix_cycles: validation.max_fix_cycles
    });
    lifecycleStore.transitionToValidationFailed(workerId, "max_cycles_exhausted");
    await safeKillRetainedWorkerAfterValidation(deps, worker.thread_id, "failed");
    return {
      status: "failed",
      score: validation.last_score ?? 0,
      reason: `max validation cycles exhausted (${validation.max_fix_cycles})`
    };
  }

  // Read the row's Context Capsule here rather than inside the prompt builder,
  // so the builder stays a pure string function — `deps.buildPrompt` overrides
  // keep their signature and the prompt tests need no filesystem. The read is
  // synchronous (see loadValidatorContextCapsule): it must not introduce a
  // macrotask before the validator spawn, because the continue handler returns
  // as soon as the spawn is recorded while `meridianApi.run` fires from the
  // background continuation. A null result is the normal case for rounds
  // generated before capsules existed and falls back to the previous prompt
  // verbatim.
  const contextCapsule = loadValidatorContextCapsule(deps.dispatchPlanPath, workerId, { log });
  if (contextCapsule) {
    log.info("Validator context capsule inlined", {
      event: "validator_context_capsule_inlined",
      worker_id: workerId,
      cycle,
      capsule_path: contextCapsule.path,
      capsule_chars: contextCapsule.content.length,
      truncated: contextCapsule.truncated,
      ...(contextCapsule.truncated ? { capsule_original_chars: contextCapsule.originalChars } : {})
    });
  }

  const promptContext: ValidatorPromptContext = {
    workerId,
    taskBranch,
    baseBranch,
    taskspecPath: deps.taskspecPath,
    dispatchPlanPath: deps.dispatchPlanPath,
    cycle,
    maxFixCycles: validation.max_fix_cycles,
    previousFeedback: validation.last_feedback,
    thresholdType,
    contextCapsule,
    expectedOutputs: worker.expected_outputs ?? []
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
    // never had a chance to verdict). Mirrors PR #185.
    if (isTransportClassRunError(errorMessage)) {
      // If the agentapi process is still alive on the host, the validator is
      // mid-flight and may produce a verdict that the hub later exposes via
      // history. Preserve validator_thread_id so the next continue tick's
      // Phase 2 can re-probe liveness and, when codex exits, recover the
      // verdict from hub history instead of respawning a parallel validator
      // (the codex_06 → codex_09 / codex_03 → codex_07 stack observed on
      // dispatchers 257976f8 and 810b6be2).
      if (isAgentapiProcessAliveForThread(validatorThreadId)) {
        log.warn("Validator run hit transport-class error but agentapi process is still alive; preserving validator thread for late-verdict recovery", {
          event: "validator_run_transport_stall_codex_alive",
          worker_id: workerId,
          validator_thread_id: validatorThreadId,
          error: reason
        });
        return { status: "error", reason };
      }
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
  const outcome = await applyValidatorVerdictFromContent(deps, workerId, validatorThreadId, content, planRow);
  if (outcome) {
    return outcome;
  }
  // applyValidatorVerdictFromContent returns null when the worker is no
  // longer in awaiting_validation by the time we re-read the lifecycle (a
  // concurrent path applied a verdict first — e.g. the watchdog's recovery
  // branch). The in-flight cycle has nothing to do in that case.
  return { status: "error", reason: "worker state changed during verdict application" };
}

// Apply a validator's textual reply (marker or JSON heuristic) to the
// lifecycle. Used both by the in-flight orchestrator (immediately after
// `meridianApi.run` resolves) and by the late-verdict recovery path in Phase 2
// (when the orchestrator's `meridianApi.run` rejected with a transport-class
// error while the agentapi/codex process was still alive — the validator
// eventually produced a verdict that the hub exposes via history). The
// recovery caller fetches the content via hub history and passes it here so
// the verdict-application logic stays in one place.
//
// Returns null when the worker is no longer in a state where a verdict can be
// applied (e.g. validation was already recorded by another path); otherwise
// returns the resulting ValidatorCycleOutcome.
export async function applyValidatorVerdictFromContent(
  deps: ValidatorOrchestratorDeps,
  workerId: string,
  validatorThreadId: string,
  content: string,
  planRow: DispatchContinuationPlanRow
): Promise<ValidatorCycleOutcome | null> {
  const { lifecycleStore, validatorConfig, log } = deps;
  const state = lifecycleStore.load();
  const worker = state.workers[workerId];
  if (!worker || worker.status !== "awaiting_validation") {
    return null;
  }
  const validation = worker.validation;
  if (!validation) {
    return null;
  }

  const thresholdType = validatorConfig.threshold_type ?? "score";
  const threshold = thresholdType === "score"
    ? resolveThresholdForWorker(validatorConfig, planRow)
    : null;
  const cycle = validation.current_cycle + 1;

  if (isValidationCycleBudgetExhausted(validation)) {
    log.warn("Validator verdict ignored because cycle budget is already exhausted", {
      event: "validator_cycle_budget_exhausted_verdict",
      worker_id: workerId,
      validator_thread_id: validatorThreadId,
      current_cycle: validation.current_cycle,
      max_fix_cycles: validation.max_fix_cycles
    });
    lifecycleStore.transitionToValidationFailed(workerId, "max_cycles_exhausted");
    await safeKill(deps.meridianApi, validatorThreadId, log);
    await safeKillRetainedWorkerAfterValidation(deps, worker.thread_id, "failed");
    return {
      status: "failed",
      score: validation.last_score ?? 0,
      reason: `max validation cycles exhausted (${validation.max_fix_cycles})`
    };
  }

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
      marker,
      planRow
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

  return applyFixRequestedWithStateIdentityGuard(deps, {
    workerId,
    planRow,
    worker,
    validation,
    validatorThreadId,
    score: parsed.score,
    feedback: parsed.feedback,
    cycle,
    maxCycles: validation.max_fix_cycles
  });
}

/**
 * Everything that must be true before the orchestrator spends another worker
 * resume + validator session on this row.
 *
 * The only guard that used to stand here was the cycle counter, so a row whose
 * worker was not permitted to change anything could be re-validated until its
 * budget ran out — see `validation-state-identity.ts` for the incident. This
 * adds the missing question: did ANYTHING observable change since the state the
 * previous cycle already judged?
 *
 * Fires only on a determinate match (see `isValidationStateIdentityUnchanged`),
 * so an unobservable row — no branch, no card, no capsule, no readable report —
 * proceeds exactly as before rather than being routed to PM on the strength of
 * our own blindness.
 */
async function applyFixRequestedWithStateIdentityGuard(
  deps: ValidatorOrchestratorDeps,
  input: {
    workerId: string;
    planRow: DispatchContinuationPlanRow;
    worker: DispatchWorkerState;
    validation: NonNullable<DispatchWorkerState["validation"]>;
    validatorThreadId: string;
    score: number;
    feedback: string;
    cycle: number;
    maxCycles: number;
  }
): Promise<ValidatorCycleOutcome> {
  const { workerId, validation, validatorThreadId, score, feedback, cycle, maxCycles } = input;
  const currentIdentity = computeStateIdentityForCycle(deps, input.workerId, input.planRow, input.worker, cycle);
  const previousIdentity = validation.state_identity ?? null;

  if (currentIdentity && isValidationStateIdentityUnchanged(previousIdentity, currentIdentity)) {
    const reason = `state unchanged since validation cycle ${previousIdentity!.cycle}`
      + ` (fingerprint ${currentIdentity.fingerprint.slice(0, 12)});`
      + " another fix cycle cannot change the objection set";

    deps.log.warn("Validator requested a fix cycle but nothing changed since the previous cycle; routing to PM", {
      event: "validator_state_identity_unchanged",
      worker_id: workerId,
      cycle,
      max_fix_cycles: maxCycles,
      previous_cycle: previousIdentity!.cycle,
      fingerprint: currentIdentity.fingerprint,
      score,
      components: summarizeValidationStateIdentity(currentIdentity)
    });

    deps.lifecycleStore.transitionToValidationStalled(
      workerId,
      "validation_state_identity_unchanged",
      {
        score,
        // Prefix rather than replace: PM needs both the orchestrator's reason
        // for stopping AND the validator's unchanged objection set to decide.
        feedback: [
          `[ORCHESTRATOR] Validation stopped at cycle ${cycle}/${maxCycles}: ${reason}.`,
          `State fingerprint ${currentIdentity.fingerprint} is byte-identical to the one recorded for cycle ${previousIdentity!.cycle}`
            + ` (${formatStateIdentityComponents(currentIdentity)}).`,
          "The worker has nothing it is permitted to change here — a PM/human decision is required"
            + " (amend the task card or capsule, re-scope the acceptance criteria, or accept the row).",
          "",
          "Validator feedback from the final cycle:",
          "",
          feedback
        ].join("\n"),
        validatorThreadId
      },
      currentIdentity
    );

    // NOTE: the retained worker thread is deliberately NOT killed here. The
    // row is heading to PM, and every other `blocked` row keeps its session so
    // PM can resume it instead of paying for a fresh spawn.
    return { status: "blocked", score, reason };
  }

  if (currentIdentity && previousIdentity && !currentIdentity.determinate) {
    deps.log.info("Validator state identity is not determinate; fix cycle proceeds without the wasted-work guard", {
      event: "validator_state_identity_indeterminate",
      worker_id: workerId,
      cycle,
      observed: currentIdentity.observed,
      components: summarizeValidationStateIdentity(currentIdentity)
    });
  }

  deps.lifecycleStore.transitionToFixRequested(
    workerId,
    score,
    feedback,
    validatorThreadId,
    currentIdentity
  );

  return {
    status: "fix_requested",
    score,
    cycle,
    maxCycles
  };
}

/**
 * Best-effort fingerprint of the row's observable state. Returns null on any
 * unexpected failure so a broken fingerprint can never block a cycle that
 * would otherwise have run — mirrors `loadValidatorContextCapsule`'s
 * fail-to-null contract on this same code path.
 */
function computeStateIdentityForCycle(
  deps: ValidatorOrchestratorDeps,
  workerId: string,
  planRow: DispatchContinuationPlanRow,
  worker: DispatchWorkerState,
  cycle: number
): ValidationStateIdentity | null {
  try {
    return computeValidationStateIdentity(
      {
        workerId,
        dispatchPlanPath: deps.dispatchPlanPath,
        // Same resolution the validator prompt uses, minus the
        // `task/<worker-id>` legacy invention: a branch we made up would
        // resolve to nothing and only ever land on `unresolved`.
        branch: resolvePlanRowBranch(workerId, planRow, deps.dispatchPlanPath),
        repoDir: deps.spawnDir,
        expectedOutputs: worker.expected_outputs ?? [],
        cycle
      },
      deps.stateIdentityIo ?? {}
    );
  } catch (error) {
    deps.log.warn("Validator state identity could not be computed; wasted-work guard is inactive for this cycle", {
      event: "validator_state_identity_error",
      worker_id: workerId,
      cycle,
      error: asErrorMessage(error)
    });
    return null;
  }
}

function formatStateIdentityComponents(identity: ValidationStateIdentity): string {
  return identity.components
    .map((component) => `${component.key}: ${component.status}`)
    .join(", ");
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
      sandboxMode: deps.validatorConfig.mode === "stateless_call" ? "read-only" : undefined,
      ...(deps.validatorConfig.credential_id !== undefined ? { credentialId: deps.validatorConfig.credential_id } : {})
    });

    // Use the active-reservation check for all modes. The broader
    // "isLifecycleThreadIdKnown" check (which blocked every ID ever seen,
    // including terminal-worker history) caused a deadlock: the Hub recycles
    // killed thread IDs back into its pool rather than advancing past the last
    // known ID, so a long-running dispatcher with many completed workers
    // exhausted the usable ID space and the spawn-retry loop never escaped.
    // Terminal workers' thread IDs are safe to reuse — the agents are dead.
    const reservedHere = isLifecycleThreadIdReserved(deps.dispatchPlanPath, spawnResult.threadId);
    const reservedCrossPlan = isThreadIdReservedAcrossOtherDispatchPlans(
      deps.otherDispatchPlanPaths ?? [],
      spawnResult.threadId
    );
    if (!reservedHere && !reservedCrossPlan) {
      return spawnResult.threadId;
    }

    // The freshly spawned validator landed on a thread id that is already an
    // active reservation. PR #134 kills the orphan spawn here to prevent leaks.
    // But when the colliding id is the *live worker thread* we are about to
    // validate, killing it terminates the worker agent itself (observed in the
    // Hub UI as "the worker had been killed before validator approval"). The
    // same applies cross-plan: if another role's lifecycle still reserves the
    // id, killing it would take out that plan's live worker/validator.
    const collidesWithLiveWorker = isLifecycleThreadIdLiveWorkerThread(
      deps.dispatchPlanPath,
      spawnResult.threadId
    );
    const skipKill = collidesWithLiveWorker || reservedCrossPlan;
    if (!skipKill) {
      await killCollidedSpawnedThread(deps.meridianApi, spawnResult.threadId, "validator spawn");
    }
    lastError = createLifecycleThreadIdCollisionError(spawnResult.threadId);
    if (attempt < VALIDATOR_SPAWN_MAX_ATTEMPTS - 1) {
      deps.log.warn("Validator spawn returned reserved lifecycle thread id, retrying", {
        event: "validator_spawn_thread_id_collision_retry",
        thread_id: spawnResult.threadId,
        attempt: attempt + 1,
        skipped_kill: skipKill,
        cross_plan: reservedCrossPlan,
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
  | { delivered: false; reason: "delivery_error"; error: string }
  | { delivered: false; reason: "transport_stall"; error: string };

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
    if (isStaleOutputArtifactRunResult(runResult)) {
      log.warn("Validator feedback returned stale output artifact; clearing worker thread for relaunch", {
        event: "validator_feedback_stale_output_artifact",
        worker_id: workerId,
        worker_thread_id: worker.thread_id,
        cycle: validation.current_cycle
      });
      const latestWorker = lifecycleStore.load().workers[workerId];
      if (latestWorker?.status === "running") {
        lifecycleStore.setWorkerStatus(workerId, "fix_requested", "validator_feedback_stale_output");
      }
      lifecycleStore.clearWorkerThreadForRelaunch(workerId, "validator_feedback_stale_output");
      return {
        delivered: false,
        reason: "delivery_error",
        error: STALE_OUTPUT_ARTIFACT_FEEDBACK_ERROR
      };
    }
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
    const transportClass = isTransportClassRunError(errorMessage);
    if (markedRunning) {
      try {
        const latestWorker = lifecycleStore.load().workers[workerId];
        if (latestWorker?.status === "running") {
          lifecycleStore.setWorkerStatus(
            workerId,
            "fix_requested",
            transportClass ? "validator_feedback_transport_stall" : "validator_feedback_error"
          );
        }
      } catch {
        // Leave the original delivery error as the observable failure.
      }
    }
    if (transportClass) {
      // Hub overload / request timeout / fetch failed / IPC drop. The worker
      // thread is most likely still alive — only the request-side promise
      // rejected. Do NOT signal a relaunch: clearing the worker thread would
      // needlessly spawn a fresh codex session and lose the live thread that
      // already received the original task prompt. Let the next continue
      // tick re-attempt feedback delivery; lifecycle is already back in
      // fix_requested. Mirrors the validator-spawn transport-stall path
      // (clearValidatorStartTransportStall, PR #203).
      log.warn("Validator feedback delivery hit transport-class error; will retry next tick", {
        event: "validator_feedback_transport_stall",
        worker_id: workerId,
        error: errorMessage
      });
      return { delivered: false, reason: "transport_stall", error: errorMessage };
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
  marker: ValidatorStatusMarker,
  planRow: DispatchContinuationPlanRow
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
      // v1.23.0 — auto-clarify on single delegatable + no blocking + target in plan.
      const autoClarified = await tryAutoClarifyDelegatable(
        deps,
        workerId,
        marker,
        worker,
        validatorThreadId,
        cycle
      );
      if (autoClarified) {
        await safeKillRetainedWorkerAfterValidation(deps, worker.thread_id, "passed");
        return autoClarified;
      }
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
      return await applyFixRequestedWithStateIdentityGuard(deps, {
        workerId,
        planRow,
        worker,
        validation,
        validatorThreadId,
        score,
        feedback,
        cycle,
        maxCycles
      });
    }
    default: {
      const _exhaustive: never = marker.outcome;
      throw new Error(`Unhandled validator marker outcome: ${_exhaustive as string}`);
    }
  }
}

/**
 * v1.23.0 — Auto-clarify a `fix_requested` marker whose unmet criterion the
 * worker's own spec already delegates to another planned worker. Returns a
 * `passed` cycle outcome when all preconditions are met; returns null when the
 * caller should fall through to the standard fix_requested handling.
 *
 * Preconditions (ALL must hold):
 * 1. Marker has at least one delegatable entry (`delegatable: ref=… target=…`).
 * 2. Marker has NO blocking entries (`blocking:` is empty / absent).
 * 3. Exactly one delegatable entry is present (multiple delegations are
 *    ambiguous and fall through to PM resolver).
 * 4. The delegated `target` is an emitted row in this dispatch plan (resolved
 *    via lifecycleStore.load().workers[target] !== undefined).
 * 5. The worker has a non-empty `expected_outputs[0]` we can append to.
 *
 * On success the helper:
 * - Appends a `## PM Clarification — Auto-delegated to <target>` section to
 *   the worker's report file (idempotent).
 * - Marks the worker validated via `transitionToValidated` with feedback that
 *   includes the auto-clarify note + the original validator feedback.
 * - Returns `{ status: "passed", score: 1.0 }` so the dispatcher continues.
 */
async function tryAutoClarifyDelegatable(
  deps: ValidatorOrchestratorDeps,
  workerId: string,
  marker: ValidatorStatusMarker,
  worker: DispatchWorkerState,
  validatorThreadId: string,
  cycle: number
): Promise<ValidatorCycleOutcome | null> {
  const blocking = parseValidatorBlocking(marker.blocking);
  if (blocking.length > 0) {
    deps.log.info("Validator auto-clarify skipped (blocking present)", {
      event: "validator_auto_clarify_skipped",
      worker_id: workerId,
      reason: "blocking_present",
      blocking_count: blocking.length
    });
    return null;
  }

  const delegatable = parseValidatorDelegatable(marker.delegatable);
  if (delegatable.length === 0) {
    return null;
  }
  if (delegatable.length > 1) {
    deps.log.info("Validator auto-clarify skipped (ambiguous delegation)", {
      event: "validator_auto_clarify_skipped",
      worker_id: workerId,
      reason: "multiple_delegatable_entries",
      delegatable_count: delegatable.length
    });
    return null;
  }

  const entry: ValidatorDelegatableEntry = delegatable[0]!;
  const state = deps.lifecycleStore.load();
  const targetExists = Object.prototype.hasOwnProperty.call(state.workers, entry.target);
  if (!targetExists) {
    deps.log.warn("Validator auto-clarify rejected (target not in plan)", {
      event: "validator_auto_clarify_rejected",
      worker_id: workerId,
      reason: "unknown_target",
      delegatable_target: entry.target,
      delegatable_ref: entry.ref
    });
    return null;
  }
  if (entry.target === workerId) {
    deps.log.warn("Validator auto-clarify rejected (self-delegation)", {
      event: "validator_auto_clarify_rejected",
      worker_id: workerId,
      reason: "self_delegation",
      delegatable_ref: entry.ref
    });
    return null;
  }

  const reportPath = worker.expected_outputs?.[0];
  if (!reportPath || reportPath.length === 0) {
    deps.log.warn("Validator auto-clarify rejected (no expected_outputs)", {
      event: "validator_auto_clarify_rejected",
      worker_id: workerId,
      reason: "no_report_path"
    });
    return null;
  }

  let clarifyResult: { appended: boolean; headingLine: string };
  try {
    clarifyResult = await appendPmClarification({
      workerReportPath: reportPath,
      workerId,
      delegatable: entry,
      validatorThreadId,
      cycle,
      validatorFeedback: marker.feedback
    });
  } catch (error) {
    deps.log.warn("Validator auto-clarify failed during PM Clarification append", {
      event: "validator_auto_clarify_write_error",
      worker_id: workerId,
      report_path: reportPath,
      delegatable_target: entry.target,
      error: asErrorMessage(error)
    });
    return null;
  }

  const clarifiedFeedback = [
    `[Auto-clarified by validator-orchestrator at cycle ${cycle}: acceptance criterion delegated to ${entry.target} per ${entry.ref}.${entry.reason ? ` Reason: ${entry.reason}.` : ""} PM Clarification ${clarifyResult.appended ? "appended" : "already present"} at ${reportPath}.]`,
    "",
    marker.feedback ?? "(no validator feedback)"
  ].join("\n");

  deps.lifecycleStore.transitionToValidated(workerId, {
    score: 1.0,
    feedback: clarifiedFeedback,
    validatorThreadId
  });

  deps.log.info("Validator auto-clarified fix_requested via delegatable", {
    event: "validator_auto_clarified",
    worker_id: workerId,
    delegatable_target: entry.target,
    delegatable_ref: entry.ref,
    cycle,
    pm_clarification_appended: clarifyResult.appended,
    report_path: reportPath
  });

  return { status: "passed", score: 1.0 };
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

/**
 * Resolves the branch the validator is told to diff.
 *
 * `planRow.branch` is the fast path, but several row-normalising mappers
 * rebuild continuation rows field-by-field and drop `branch` on the way, and
 * one call site casts `DispatchPlanWorkerRow[]` straight to
 * `DispatchContinuationPlanRow[]`. When that happens the old code silently
 * invented `task/<worker-id>` — a ref that does not exist in any modern plan.
 * Every validator then opened with a failing `git diff`, and each one
 * improvised its evidence instead (observed on agent-dispatcher-abd83457:
 * C-02, C-04b, C-07, C-09 and BATCH-7-GATE all reported the `task/<id>` ref
 * absent; one of them scored a stale head the worker had already fixed).
 *
 * So before inventing anything, re-read the plan on disk — it is the same
 * document the row came from, and it always carries the Branch column.
 */
function resolveTaskBranch(
  workerId: string,
  planRow: DispatchContinuationPlanRow,
  dispatchPlanPath: string,
  log: Pick<Logger, "info" | "warn">
): string {
  const explicitBranch = normalizePlanBranch(planRow.branch);
  if (explicitBranch) {
    return explicitBranch;
  }

  const planBranch = readTaskBranchFromDispatchPlan(dispatchPlanPath, workerId);
  if (planBranch) {
    log.warn("Validator task branch missing from plan row; recovered from dispatch plan", {
      event: "validator_task_branch_recovered_from_plan",
      worker_id: workerId,
      branch: planBranch
    });
    return planBranch;
  }

  // Legacy fallback for older dispatch plans that do not expose a Branch column.
  return `task/${workerId.toLowerCase()}`;
}

/**
 * The row's real branch, or null when it genuinely has none — the NO-GIT rows
 * (`BATCH-*-GATE`, `LEGACY-ZERO-GATE`, `W0-03`, …) that carry no branch column
 * value at all.
 *
 * Unlike {@link resolveTaskBranch} this never invents `task/<worker-id>`. The
 * state-identity fingerprint must distinguish "this row has no branch" from
 * "this row's branch could not be resolved", and a synthetic ref that exists in
 * no plan would always land on the latter — turning every legacy row's guard
 * off for the wrong reason.
 */
function resolvePlanRowBranch(
  workerId: string,
  planRow: DispatchContinuationPlanRow,
  dispatchPlanPath: string
): string | null {
  return normalizePlanBranch(planRow.branch)
    ?? readTaskBranchFromDispatchPlan(dispatchPlanPath, workerId);
}

/**
 * Synchronous by design, mirroring `loadValidatorContextCapsule`: this runs
 * once per validation cycle, immediately before a spawn that costs minutes.
 * Returns null on any read/parse problem so branch recovery can never break a
 * cycle that would otherwise have run.
 */
function readTaskBranchFromDispatchPlan(dispatchPlanPath: string, workerId: string): string | null {
  try {
    const markdown = fs.readFileSync(dispatchPlanPath, "utf8");
    const target = workerId.trim().toUpperCase();
    const row = parseDispatchPlanRows(markdown).find(
      (candidate) => candidate.worker_id.trim().toUpperCase() === target
    );
    return normalizePlanBranch(row?.branch);
  } catch {
    return null;
  }
}

function normalizePlanBranch(branch: string | null | undefined): string | null {
  const trimmed = branch?.trim().replace(/^`|`$/gu, "") ?? "";
  if (!trimmed || trimmed === "-" || trimmed === "—" || /^n\/a$/iu.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function isCompletedRunResult(runResult: MeridianRunResult): boolean {
  const status = runResult.status.trim().toLowerCase();
  const runState = runResult.runState?.trim().toLowerCase();
  return status === "success" && (!runState || runState === "completed");
}

function isValidationCycleBudgetExhausted(
  validation: NonNullable<DispatchWorkerState["validation"]>
): boolean {
  return validation.max_fix_cycles > 0 && validation.current_cycle >= validation.max_fix_cycles;
}

function isStaleOutputArtifactRunResult(runResult: MeridianRunResult): boolean {
  const rawSource = runResult.raw.source;
  if (typeof rawSource === "string" && rawSource.trim().toLowerCase() === "output_artifact") {
    return true;
  }

  return /^Recovered\s+\S+\s+result from output artifact:/i.test(runResult.content?.trim() ?? "");
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
