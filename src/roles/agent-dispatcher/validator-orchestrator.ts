import type { Logger } from "../base-role";
import type { ValidatorConfig } from "../../types";
import type { LifecycleStore } from "./lifecycle-store";
import type { MeridianApiClient, MeridianRunResult } from "./meridian-api-client";
import type { DispatchContinuationPlanRow } from "./service-continuation";
import {
  createLifecycleThreadIdCollisionError,
  isLifecycleThreadIdReserved
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
  spawnDir: string;
  dispatchPlanPath: string;
  taskspecPath: string | null;
  buildPrompt?: (context: ValidatorPromptContext) => string;
  log: Pick<Logger, "info" | "warn">;
}

export interface ParsedValidatorOutput {
  score: number;
  feedback: string;
}

// ─── Per-task override parsing ──────────────────────────────────────────────────

const VALIDATE_OFF_PATTERN = /\bvalidate\s*:\s*off\b/i;
const VALIDATE_THRESHOLD_PATTERN = /\bvalidate\s*:\s*threshold\s*=\s*([\d.]+)/i;

const EXCLUDED_MODEL_CODES = new Set(["HUMAN", "PM"]);
const VALIDATOR_SPAWN_MAX_ATTEMPTS = 3;

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

  const threshold = resolveThresholdForWorker(validatorConfig, planRow);
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
    previousFeedback: validation.last_feedback
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
    const reason = `validator run failed: ${asErrorMessage(error)}`;
    log.warn("Validator run failed", { event: "validator_run_error", worker_id: workerId, error: reason });
    await safeKill(meridianApi, validatorThreadId, log);
    lifecycleStore.clearValidatorStart(workerId, validatorThreadId);
    return { status: "error", reason };
  }

  // Kill validator (ephemeral)
  await safeKill(meridianApi, validatorThreadId, log);

  // Parse result
  const content = runResult.content ?? "";
  const parsed = parseValidatorOutput(content);
  if (!parsed) {
    log.warn("Validator output unparseable", {
      event: "validator_parse_error",
      worker_id: workerId,
      content_length: content.length
    });
    lifecycleStore.clearValidatorStart(workerId, validatorThreadId);
    return { status: "error", reason: "could not parse validator output" };
  }

  log.info("Validator scored", {
    event: "validator_scored",
    worker_id: workerId,
    score: parsed.score,
    threshold,
    cycle
  });

  // Decision gate
  if (parsed.score >= threshold) {
    lifecycleStore.transitionToValidated(workerId, {
      score: parsed.score,
      feedback: parsed.feedback,
      validatorThreadId
    });
    return { status: "passed", score: parsed.score };
  }

  if (cycle >= validation.max_fix_cycles) {
    lifecycleStore.transitionToValidationFailed(workerId, "max_cycles_exhausted", {
      score: parsed.score,
      feedback: parsed.feedback,
      validatorThreadId
    });
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
      autoApprove: deps.validatorConfig.auto_approve
    });

    if (!isLifecycleThreadIdReserved(deps.dispatchPlanPath, spawnResult.threadId)) {
      return spawnResult.threadId;
    }

    lastError = createLifecycleThreadIdCollisionError(spawnResult.threadId);
    if (attempt < VALIDATOR_SPAWN_MAX_ATTEMPTS - 1) {
      deps.log.warn("Validator spawn returned reserved lifecycle thread id, retrying", {
        event: "validator_spawn_thread_id_collision_retry",
        thread_id: spawnResult.threadId,
        attempt: attempt + 1,
        error: lastError.message
      });
    }
  }

  throw lastError ?? new Error("validator spawn failed: no attempts completed");
}

// ─── Feedback delivery ──────────────────────────────────────────────────────────

export async function deliverValidatorFeedback(
  deps: ValidatorOrchestratorDeps,
  workerId: string
): Promise<boolean> {
  const { lifecycleStore, meridianApi, log } = deps;

  const state = lifecycleStore.load();
  const worker = state.workers[workerId];
  if (!worker || worker.status !== "fix_requested") {
    return false;
  }

  const validation = worker.validation;
  if (!validation?.last_feedback || validation.last_score === null || validation.last_score === undefined) {
    return false;
  }

  const feedbackMessage = [
    `[VALIDATOR FEEDBACK] Cycle ${validation.current_cycle}/${validation.max_fix_cycles} | Score: ${validation.last_score}`,
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
      error: asErrorMessage(error)
    });
    return false;
  }

  return true;
}

// ─── Output parsing ─────────────────────────────────────────────────────────────

export function parseValidatorOutput(content: string): ParsedValidatorOutput | null {
  // Try to find a JSON code block first
  const codeBlockMatch = content.match(/```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/);
  if (codeBlockMatch?.[1]) {
    const result = tryParseJson(codeBlockMatch[1]);
    if (result) {
      return result;
    }
  }

  // Fallback: find last JSON object in content
  const jsonMatches = [...content.matchAll(/\{[^{}]*"score"\s*:\s*[\d.]+[^{}]*\}/g)];
  if (jsonMatches.length > 0) {
    const lastMatch = jsonMatches[jsonMatches.length - 1]![0];
    const result = tryParseJson(lastMatch);
    if (result) {
      return result;
    }
  }

  return null;
}

function tryParseJson(raw: string): ParsedValidatorOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" && parsed !== null
      && "score" in parsed && typeof (parsed as Record<string, unknown>).score === "number"
      && "feedback" in parsed && typeof (parsed as Record<string, unknown>).feedback === "string"
    ) {
      const score = (parsed as { score: number }).score;
      const feedback = (parsed as { feedback: string }).feedback;
      if (score >= 0 && score <= 1) {
        return { score, feedback };
      }
    }
  } catch {
    // ignore parse errors
  }
  return null;
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

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
