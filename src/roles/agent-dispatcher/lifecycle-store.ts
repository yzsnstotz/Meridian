import * as fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { Logger } from "../base-role";
import {
  DispatchThreadStateV2Schema,
  type DispatchThreadStateV2,
  type DispatchWorkerState,
  type HubResult,
  type LifecycleStatus,
  type LifecycleWorkerEntry
} from "../../types";

const EPOCH_ISO = new Date(0).toISOString();
const DISPATCH_PLAN_FILENAME = "dispatch_plan.md";
const DISPATCH_THREADS_FILENAME = "dispatch_threads.json";

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
  abandoned: "⚠️ ABANDONED",
  skipped: "⛔ SKIPPED",
  awaiting_validation: "🔍",
  fix_requested: "🔁"
};

export interface LifecycleStoreOptions {
  beforeCommit?: (tempFilePath: string, targetFilePath: string) => void;
  dispatchPlanPath?: string;
  log?: Pick<Logger, "info">;
  now?: () => string;
}

export class LifecycleStore {
  readonly filePath: string;

  private readonly beforeCommit?: (tempFilePath: string, targetFilePath: string) => void;
  private readonly dispatchPlanPath: string;
  private readonly log: Pick<Logger, "info">;
  private readonly now: () => string;

  constructor(filePath: string, options: LifecycleStoreOptions = {}) {
    this.filePath = filePath;
    this.beforeCommit = options.beforeCommit;
    this.dispatchPlanPath = options.dispatchPlanPath ?? inferDispatchPlanPath(filePath);
    this.log = options.log ?? console;
    this.now = options.now ?? (() => new Date().toISOString());
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

  recordWorkerStart(
    workerId: string,
    threadId: string,
    traceId: string,
    expectedOutputs: string[],
    commandPreamble?: string | null
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
    const shouldIncrementRetry = previousStatus === "failed" || previousStatus === "abandoned";

    state.workers[workerId] = {
      thread_id: threadId,
      trace_id: traceId,
      started_at: nowIso,
      last_seen_at: nowIso,
      status: "running",
      expected_outputs: [...expectedOutputs],
      hub_result: null,
      command_preamble: commandPreamble ?? null,
      retry_count: shouldIncrementRetry ? previousRetryCount + 1 : previousRetryCount
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

    const nextStatus = mapHubResultToLifecycleStatus(workerId, hubResult, worker.expected_outputs);
    state.workers[workerId] = {
      ...worker,
      thread_id: hubResult.thread_id || worker.thread_id,
      trace_id: hubResult.trace_id || worker.trace_id,
      last_seen_at: hubResult.timestamp,
      status: nextStatus,
      hub_result: hubResult
    };

    this.logTransition(workerId, worker.status, nextStatus, "hub_result");
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
      retry_count: shouldIncrementRetryCount ? baseRetryCount + 1 : baseRetryCount
    };

    this.logTransition(workerId, worker.status, status, trigger);
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

  transitionToAwaitingValidation(workerId: string, maxFixCycles: number): void {
    this.mutate((state) => {
      const worker = state.workers[workerId];
      if (!worker) return;

      const prevStatus = worker.status;
      worker.status = "awaiting_validation";
      worker.validation = {
        current_cycle: worker.validation?.current_cycle ?? 0,
        max_fix_cycles: maxFixCycles,
        validator_thread_id: null,
        last_score: worker.validation?.last_score ?? null,
        last_feedback: worker.validation?.last_feedback ?? null,
        history: worker.validation?.history ?? []
      };
      this.logTransition(workerId, prevStatus, "awaiting_validation", "validation_intercept");
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
      recordValidationOutcome(worker, score, feedback, validatorThreadId, this.now);
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
}

interface ValidationTransitionResult {
  score: number;
  feedback: string;
  validatorThreadId: string;
}

function recordValidationOutcome(
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
  worker.validation.current_cycle = cycle;
  worker.validation.last_score = score;
  worker.validation.last_feedback = feedback;
  worker.validation.validator_thread_id = null;
  worker.validation.history.push({
    cycle,
    score,
    feedback,
    validator_thread_id: validatorThreadId,
    timestamp: now()
  });
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
      // output itself contains failure evidence. A stale ✅ must not hide a
      // failed acceptance report.
      const currentPlanStatus = rowCells[statusColumn].trim();
      const nextPlanStatus = resolveDisplayStatus(workerState);
      const hasFailureEvidence =
        workerState.status === "failed" ||
        (workerState.hub_result ? hubResultContainsFailureSignal(workerState.hub_result) : false);
      if (
        isPlanStatusTerminalSuccess(currentPlanStatus)
        && nextPlanStatus !== currentPlanStatus
        && nextPlanStatus !== PLAN_STATUS_SYMBOLS.running
        && !hasFailureEvidence
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
    last_reconciled_at: null
  });
}

function mapHubResultToLifecycleStatus(workerId: string, hubResult: HubResult, expectedOutputs: string[]): LifecycleStatus {
  const deferSuccessUntilReconciled = requiresOutputVerification(expectedOutputs);

  if (hubResult.status === "error") {
    return "failed";
  }

  if (hubResult.status === "timeout" || hubResult.run_state === "timeout") {
    // A timeout marker means the relay/hub timed out, NOT that the worker
    // itself failed. Leave the worker as "running" so the reconciler can
    // validate the actual thread status and outputs before making a terminal
    // judgment.
    return "running";
  }

  if (hubResultContainsHitLimit(hubResult)) {
    return "failed";
  }

  if (hubResultContainsFailureSignal(hubResult)) {
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
      expectedOutputsExist(expectedOutputs)
      || reportedOutputsExist(hubResult, expectedOutputs)
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

const NON_COMPLETION_PATTERNS = [
  /⏸\s*PAUSE/,
  /⛔\s*BLOCKED/,
  /PAUSE\s*[—–-]/,
  /BLOCKED\s*[—–-]/
];

const HIT_LIMIT_PATTERNS = [
  /(?:^|[\s>])[:;=-]?\s*hit\s+limit\b/i,
  /\bcontext(?:\s+window)?\s+limit\b/i,
  /\btoken\s+limit\b/i
];

const STRUCTURED_FAILURE_SIGNAL_PATTERNS = [
  /(?:^|\n)\s*(?:#{1,6}\s*)?Outcome\s*\n+\s*`?\s*(?:FAILED|BLOCKED)\b/i,
  /(?:^|\n)\s*(?:-\s*)?Outcome\s*:?\s*`?\s*(?:FAILED|BLOCKED)\b/i,
  /(?:^|\n)\s*(?:-\s*)?Status\s*:?\s*`?\s*(?:FAILED|BLOCKED)\b/i,
  /(?:^|\n)\s*-\s*Result:\s*`?\s*⛔\s*(?:FAILED|BLOCKED)\b/i,
  /(?:^|\n)\s*Result:\s*`?\s*⛔\s*(?:FAILED|BLOCKED)\b/i,
  /"result"\s*:\s*"(?:failed|blocked|error)"/i,
  /"exit_code"\s*:\s*[1-9]\d*/i,
  /(?:^|\n)\s*FAIL:\s+/i
];

const CONTEXTUAL_FAILURE_SIGNAL_PATTERNS = [
  /⛔\s*BLOCKED\b/i,
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

  return combinedContent
    .split(/\r?\n/)
    .some((line) => {
      const normalized = line.trim();
      return normalized.length > 0
        && !isBenignFailureContextLine(normalized)
        && CONTEXTUAL_FAILURE_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized));
    });
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

function extractAgentReplyDetailsText(detailsText: string | undefined): string | null {
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

function isBenignFailureContextLine(line: string): boolean {
  return BENIGN_FAILURE_CONTEXT_PATTERNS.some((pattern) => pattern.test(line));
}

function requiresOutputVerification(expectedOutputs: string[]): boolean {
  return expectedOutputs.length > 0;
}

function expectedOutputsExist(expectedOutputs: string[]): boolean {
  if (expectedOutputs.length === 0) {
    return false;
  }

  return expectedOutputs.every((filePath) => {
    if (!fs.existsSync(filePath)) {
      return false;
    }

    try {
      return fs.statSync(filePath).size > 0;
    } catch {
      return false;
    }
  });
}

function reportedOutputsExist(hubResult: HubResult, expectedOutputs: string[] = []): boolean {
  return extractReportedOutputPaths(hubResult).some((filePath) => {
    if (!reportedOutputMatchesExpected(filePath, expectedOutputs)) {
      return false;
    }

    if (!isCompletionArtifactPath(filePath) || !fs.existsSync(filePath)) {
      return false;
    }

    try {
      return fs.statSync(filePath).size > 0;
    } catch {
      return false;
    }
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
  if (worker.status !== "failed" && worker.hub_result && hubResultContainsFailureSignal(worker.hub_result)) {
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
